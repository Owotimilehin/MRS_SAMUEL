import { useCallback, useEffect, useRef, useState } from "react";
import { SearchBox } from "@mapbox/search-js-react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

/**
 * Checkout address picker. Powered by Mapbox autocomplete so the customer can
 * only submit a *complete, geocoded* address — which is what Shipbubble's
 * `/address/validate` needs (vague free-text 400s and drops us to the flat
 * fallback fee). On select we capture the canonical formatted address + lat/lng.
 *
 * Resilience: if `VITE_MAPBOX_TOKEN` is unset we fall back to a plain textarea
 * (today's behaviour) so checkout never hard-breaks; the customer can also opt
 * into manual entry at any time for informal addresses Mapbox can't resolve.
 */
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

export interface AddressValue {
  address: string;
  lat: number | null;
  lng: number | null;
}

interface Props {
  value: AddressValue;
  onChange: (v: AddressValue) => void;
}

export function AddressAutocomplete({ value, onChange }: Props): JSX.Element {
  if (!MAPBOX_TOKEN) {
    return <ManualAddress value={value} onChange={onChange} />;
  }
  return <MapboxAddress token={MAPBOX_TOKEN} value={value} onChange={onChange} />;
}

/** Reverse-geocode a point to a formatted Nigerian address string, or null. */
async function reverseGeocode(
  token: string,
  lng: number,
  lat: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const url =
    `https://api.mapbox.com/search/geocode/v6/reverse?longitude=${lng}` +
    `&latitude=${lat}&country=ng&limit=1&access_token=${token}`;
  try {
    const res = await fetch(url, signal ? { signal } : {});
    if (!res.ok) return null;
    const json = (await res.json()) as {
      features?: { properties?: { full_address?: string; place_formatted?: string } }[];
    };
    const p = json.features?.[0]?.properties;
    return p?.full_address ?? p?.place_formatted ?? null;
  } catch {
    return null;
  }
}

function MapboxAddress({
  token,
  value,
  onChange,
}: Props & { token: string }): JSX.Element {
  const [manual, setManual] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);

  // Keep the latest callback/value out of the map effect's deps so the map
  // isn't torn down and rebuilt on every keystroke.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const addressRef = useRef(value.address);
  addressRef.current = value.address;

  const hasCoords = value.lat != null && value.lng != null;

  // Build (once) / recenter the preview map whenever we hold coordinates.
  useEffect(() => {
    if (manual || !hasCoords || !containerRef.current) return;
    const lngLat: [number, number] = [value.lng as number, value.lat as number];

    if (!mapRef.current) {
      mapboxgl.accessToken = token;
      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: "mapbox://styles/mapbox/streets-v12",
        center: lngLat,
        zoom: 15,
        attributionControl: false,
      });
      const marker = new mapboxgl.Marker({ draggable: true, color: "#f97316" })
        .setLngLat(lngLat)
        .addTo(map);
      marker.on("dragend", () => {
        const ll = marker.getLngLat();
        void reverseGeocode(token, ll.lng, ll.lat).then((addr) => {
          onChangeRef.current({
            address: addr ?? addressRef.current,
            lat: ll.lat,
            lng: ll.lng,
          });
        });
      });
      mapRef.current = map;
      markerRef.current = marker;
    } else {
      mapRef.current.setCenter(lngLat);
      markerRef.current?.setLngLat(lngLat);
    }
  }, [manual, hasCoords, value.lat, value.lng, token]);

  // Tear the map down on unmount / when switching to manual entry.
  useEffect(() => {
    if (manual && mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
      markerRef.current = null;
    }
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, [manual]);

  if (manual) {
    return (
      <>
        <ManualAddress value={value} onChange={onChange} token={token} />
        <ToggleLink onClick={() => setManual(false)}>← Search for my address instead</ToggleLink>
      </>
    );
  }

  return (
    <>
      <SearchBox
        accessToken={token}
        value={value.address}
        onChange={(text) => onChange({ address: text, lat: null, lng: null })}
        onRetrieve={(res) => {
          const f = res.features?.[0];
          const coords = f?.geometry?.coordinates;
          if (!f || !coords || coords.length < 2) return;
          const [lng, lat] = coords as [number, number];
          const addr = f.properties.full_address ?? f.properties.place_formatted ?? value.address;
          onChange({ address: addr, lat, lng });
        }}
        options={{
          language: "en",
          country: "NG",
          types: "address,street,place,locality,neighborhood,poi",
          ...(hasCoords ? { proximity: { lng: value.lng as number, lat: value.lat as number } } : {}),
        }}
        theme={{ variables: { fontFamily: "inherit", borderRadius: "10px" } }}
        placeholder="Start typing your address…"
      />
      {hasCoords && (
        <div
          ref={containerRef}
          style={{
            height: 180,
            marginTop: 8,
            borderRadius: 12,
            overflow: "hidden",
            border: "1px solid var(--line, #e5e5e5)",
          }}
        />
      )}
      <div className="ms-checkout__hint" style={{ marginTop: 6 }}>
        {hasCoords
          ? "Drag the pin to fine-tune the exact spot."
          : "Pick a suggestion so we can confirm live delivery to your door."}
        {"  "}
        <ToggleLink onClick={() => setManual(true)}>Can't find it? Enter manually</ToggleLink>
      </div>
    </>
  );
}

/** Plain textarea + "use my location" — the no-token / manual-entry fallback. */
function ManualAddress({
  value,
  onChange,
  token,
}: Props & { token?: string }): JSX.Element {
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  const useMyLocation = useCallback((): void => {
    if (!navigator.geolocation) {
      setGeoError("Your browser doesn't support location.");
      return;
    }
    setGeoLoading(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        if (token) {
          void reverseGeocode(token, lng, lat).then((addr) => {
            onChange({ address: addr ?? value.address, lat, lng });
            setGeoLoading(false);
          });
        } else {
          onChange({ address: value.address, lat, lng });
          setGeoLoading(false);
        }
      },
      (err) => {
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied. Type your address instead."
            : "Couldn't get your location. Type your address instead.",
        );
        setGeoLoading(false);
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, [onChange, token, value.address]);

  const hasCoords = value.lat != null && value.lng != null;

  return (
    <>
      <textarea
        className="ms-checkout__input"
        rows={2}
        value={value.address}
        onChange={(e) => onChange({ address: e.target.value, lat: value.lat, lng: value.lng })}
        required
        autoComplete="street-address"
      />
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}
      >
        <button
          type="button"
          className="btn btn--subtle btn--sm"
          onClick={useMyLocation}
          disabled={geoLoading}
          style={{ fontSize: 12 }}
        >
          {geoLoading ? "Locating…" : hasCoords ? "✓ Using my location" : "📍 Use my location"}
        </button>
        {geoError && <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>{geoError}</span>}
        {hasCoords && (
          <button
            type="button"
            onClick={() => onChange({ address: value.address, lat: null, lng: null })}
            style={{
              background: "transparent",
              border: 0,
              color: "var(--ink-soft)",
              fontSize: 12,
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            Clear
          </button>
        )}
      </div>
    </>
  );
}

function ToggleLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "transparent",
        border: 0,
        color: "var(--accent)",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        textDecoration: "underline",
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}
