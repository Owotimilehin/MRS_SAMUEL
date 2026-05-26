/**
 * `/shop` is an alias for the landing-page menu section per UI_SPEC §4.A C2.
 * The full menu lives on `/` under `#menu`; this route exists so external
 * links / bookmarks to `/shop` resolve to the same content.
 */
export function ShopPage(): JSX.Element | null {
  if (typeof window !== "undefined") {
    window.location.replace("/#menu");
  }
  return null;
}
