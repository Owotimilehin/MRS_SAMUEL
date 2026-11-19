/**
 * Catalogue (suite spec 08, 7.2): the shop's juices on WhatsApp. The suite
 * copies them from the shop; nobody types a product into Meta. This page
 * connects the catalogue, holds the switches, and shows every item with the
 * reason Meta refused it in plain words.
 *
 * Nothing here sends a customer a message. The two switches that let the suite
 * write to customers by itself are the owner's alone and start off.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, RefreshCw } from "lucide-react";
import { formatNaira } from "@ms/shared";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { InlineLoader } from "@admin/components/Spinner.js";
import { ApiError } from "@admin/lib/api.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useAuthUser, useCan } from "@admin/lib/auth.js";
import { inboxKeys } from "@admin/lib/inbox-api.js";
import { toast } from "@admin/lib/toast.js";
import "@admin/components/inbox/inbox.css";
import "./catalogue.css";
import {
  catalogueApi,
  catalogueKeys,
  type CatalogueItem,
  type CatalogueLink,
  type CatalogueStatus,
  type SettingsPatch,
} from "./catalogue-api.js";
import {
  chooseBanner,
  countChips,
  lagosTime,
  looksLikeCatalogueId,
  matchesFilter,
  sortItems,
  stateLabel,
  stateTone,
  stockLabel,
  templatesNotReady,
  type CountFilter,
} from "./catalogue-logic.js";
import { ConnectCatalogueDialog } from "./ConnectCatalogueDialog.js";
import { ItemProblemDialog } from "./ItemProblemDialog.js";

const SUB_LINE = "Your juices on WhatsApp. The suite copies them from the shop; you never type them into Meta.";

export function CataloguePage(): JSX.Element {
  const can = useCan();
  if (!can("catalogue.manage")) {
    return (
      <Frame title="Catalogue">
        <div className="card">You don&apos;t have access to the catalogue. Ask the owner.</div>
      </Frame>
    );
  }
  return <CatalogueScreen />;
}

function CatalogueScreen(): JSX.Element {
  const status = useQuery({
    queryKey: catalogueKeys.status,
    queryFn: catalogueApi.status,
    // The worker changes item states in the background; keep the page honest without a reload.
    refetchInterval: 15_000,
  });

  let body: JSX.Element;
  if (status.isLoading) {
    body = <InlineLoader />;
  } else if (status.error || !status.data) {
    body = (
      <div className="empty" style={{ display: "grid", gap: 12, justifyItems: "center" }}>
        <div>We couldn&apos;t load the catalogue. Check your connection and try again.</div>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => void status.refetch()}>
          Try again
        </button>
      </div>
    );
  } else if (!status.data.configured) {
    body = <div className="card">WhatsApp is not connected on this server yet, so there is nothing to sync.</div>;
  } else if (!status.data.link) {
    body = <ConnectCard />;
  } else {
    body = <Linked status={status.data} link={status.data.link} />;
  }

  return (
    <Frame title="Catalogue">
      <div className="cat-page">
        <p className="cat-sub">{SUB_LINE}</p>
        {body}
      </div>
    </Frame>
  );
}

/** Not linked yet: paste the catalogue ID. */
function ConnectCard(): JSX.Element {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect(): Promise<void> {
    const id = value.trim();
    if (!looksLikeCatalogueId(id)) {
      setError("That doesn't look like a catalogue ID. It should be numbers only.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await catalogueApi.link(id);
      toast.success("Catalogue connected.");
      await qc.invalidateQueries({ queryKey: catalogueKeys.status });
    } catch (err) {
      const meta = err instanceof ApiError && err.details?.["reason"] === "catalogue_unreachable" ? String(err.details["meta_message"] ?? "") : null;
      if (meta !== null) {
        setError(
          `Meta wouldn't let us open that catalogue. Check the ID, and check the system user has full control of it.${meta ? ` (Meta said: ${meta})` : ""}`,
        );
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card cat-card">
      <h2 className="cat-h">Connect your catalogue</h2>
      <p style={{ margin: 0 }}>
        Create one catalogue in Meta Commerce Manager, give the suite&apos;s system user full control of it, then paste its ID
        here. The steps are in the help note below.
      </p>
      <label className="field">
        <span className="field__label">Catalogue ID</span>
        <input
          className="input"
          inputMode="numeric"
          autoComplete="off"
          value={value}
          maxLength={30}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void connect();
          }}
        />
        <span className="field__hint">A long number, for example 123456789012345</span>
        {error && (
          <span className="field__error" role="alert">
            {error}
          </span>
        )}
      </label>
      <div>
        <button type="button" className="btn btn--primary" disabled={busy || !value.trim()} onClick={() => void connect()}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
      <details>
        <summary style={{ cursor: "pointer", fontWeight: 700 }}>How to do this in Meta</summary>
        <ol className="cat-steps" style={{ marginTop: 8 }}>
          <li>
            In Meta Commerce Manager, create a catalogue: type “E-commerce”, choose “Upload product info”, owner your business
            account, name “Mrs Samuel Juices”. Do not add products by hand.
          </li>
          <li>Copy the catalogue ID: the long number under the catalogue&apos;s name in Commerce Manager, Settings.</li>
          <li>
            In Business Settings, Data sources, Catalogues, pick the catalogue, choose “Assign people”, pick the suite&apos;s
            system user and turn on “Manage catalogue”. Save.
          </li>
        </ol>
      </details>
    </section>
  );
}

function Linked({ status, link }: { status: CatalogueStatus; link: CatalogueLink }): JSX.Element {
  const qc = useQueryClient();
  const user = useAuthUser();
  const isOwner = user.role === "owner";
  const [filter, setFilter] = useState<CountFilter>("all");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"connect" | "full" | "unlink" | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [why, setWhy] = useState<CatalogueItem | null>(null);

  // Search as the person types, without a request per key press.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const items = useQuery({
    queryKey: catalogueKeys.items("all", q),
    queryFn: () => catalogueApi.items(q ? { q } : {}),
    refetchInterval: 15_000,
  });
  const shown = useMemo(
    () => sortItems((items.data?.items ?? []).filter((i) => matchesFilter(i.state, filter))),
    [items.data, filter],
  );

  const refresh = async (): Promise<void> => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: catalogueKeys.status }),
      qc.invalidateQueries({ queryKey: catalogueKeys.allItems }),
      // The inbox's Products button appears once the catalogue is connected.
      qc.invalidateQueries({ queryKey: inboxKeys.catalogueSendable }),
    ]);
  };

  async function run(key: string, fn: () => Promise<unknown>, done?: string): Promise<void> {
    setBusy(key);
    try {
      await fn();
      if (done) toast.success(done);
      await refresh();
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(null);
    }
  }

  const setSwitch = (patch: SettingsPatch): Promise<void> => run(Object.keys(patch)[0] ?? "settings", () => catalogueApi.settings(patch));

  async function connectWhatsApp(): Promise<void> {
    await run("connect", async () => {
      const result = await catalogueApi.connectWhatsApp();
      if (result.warning) toast.info(result.warning);
      else toast.success("Connected to WhatsApp.");
    });
    setConfirm(null);
  }

  async function retry(item: CatalogueItem): Promise<void> {
    await run(`retry:${item.id}`, () => catalogueApi.retry(item.id), "We'll send it again now.");
    setWhy(null);
  }

  const banner = chooseBanner(status);
  const chips = countChips(status.counts);
  const notReady = templatesNotReady(status.templates);
  const total = Object.values(status.counts).reduce((a, b) => a + b, 0);
  const sendable = status.counts.live + status.counts.pending + status.counts.sent + status.counts.rejected;

  return (
    <>
      {banner && (
        <div className={`cat-strip cat-strip--${banner.tone}`} role="alert">
          {banner.text}
        </div>
      )}

      <section className="card cat-card">
        <div>
          <h2 className="cat-h">{link.name ?? "Catalogue"}</h2>
          <p className="cat-fine">Catalogue ID {link.catalog_id}</p>
        </div>
        <div>
          <div className="cat-row">
            <div className="cat-row__text">
              <span className="cat-row__label">{link.whatsapp_connected ? "WhatsApp: connected" : "WhatsApp: not connected"}</span>
              {!link.whatsapp_connected && (
                <span className="cat-fine">Customers cannot see your menu or send a cart until the catalogue is connected.</span>
              )}
            </div>
            {!link.whatsapp_connected && (
              <button type="button" className="btn btn--primary btn--sm" disabled={busy !== null} onClick={() => setConfirm("connect")}>
                Connect to WhatsApp
              </button>
            )}
          </div>

          <SwitchRow
            label="Keep WhatsApp in step with the shop"
            checked={link.sync_enabled}
            busy={busy === "sync_enabled"}
            help={link.sync_enabled ? `On. Last checked ${lagosTime(link.last_sync_at)}.` : "Off. Nothing is being sent to Meta."}
            onChange={(v) => void setSwitch({ sync_enabled: v })}
          />
          <SwitchRow
            label="Show the menu button on our WhatsApp profile"
            checked={link.is_catalog_visible === true}
            busy={busy === "is_catalog_visible"}
            disabled={!link.whatsapp_connected}
            help={link.whatsapp_connected ? undefined : "Connect the catalogue to WhatsApp first."}
            onChange={(v) => void setSwitch({ is_catalog_visible: v })}
          />
          <SwitchRow
            label="Let customers send a cart"
            checked={link.is_cart_enabled === true}
            busy={busy === "is_cart_enabled"}
            disabled={!link.whatsapp_connected}
            help={link.whatsapp_connected ? undefined : "Connect the catalogue to WhatsApp first."}
            onChange={(v) => void setSwitch({ is_cart_enabled: v })}
          />
          <SwitchRow
            label="Ask “delivery or pickup?” automatically when a cart arrives"
            checked={link.ask_fulfilment_auto}
            busy={busy === "ask_fulfilment_auto"}
            disabled={!isOwner}
            help={
              isOwner
                ? link.ask_fulfilment_auto
                  ? "On. The suite asks the question, and the follow-up for the address, without a person."
                  : "Off. Staff ask from the cart beside the chat."
                : "Only the owner can change this."
            }
            onChange={(v) => void setSwitch({ ask_fulfilment_auto: v })}
          />
          <SwitchRow
            label="Tell customers when their order is paid, on its way and delivered"
            checked={link.order_updates_enabled}
            busy={busy === "order_updates_enabled"}
            disabled={!isOwner}
            help={isOwner ? (link.order_updates_enabled ? "On." : "Off. Customers are not told by WhatsApp.") : "Only the owner can change this."}
            warning={
              notReady.length > 0
                ? `These messages need approved WhatsApp templates. Missing or not approved: ${notReady.join(", ")}. Until then, updates are only sent while the customer's 24-hour chat window is open.`
                : undefined
            }
            onChange={(v) => void setSwitch({ order_updates_enabled: v })}
          />
        </div>
      </section>

      <section className="card cat-card">
        <div className="cat-chips" role="group" aria-label="Filter juices">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className="cat-chip"
              aria-pressed={filter === chip.key}
              onClick={() => setFilter((f) => (f === chip.key ? "all" : chip.key))}
            >
              {chip.label} {chip.n}
            </button>
          ))}
        </div>
        <div className="cat-tools">
          <input
            className="input"
            type="search"
            placeholder="Search juices"
            aria-label="Search juices"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            type="button"
            className="btn btn--subtle btn--sm"
            disabled={busy !== null || !link.sync_enabled}
            title={link.sync_enabled ? undefined : "Switch on “Keep WhatsApp in step with the shop” first."}
            onClick={() => void run("sync", () => catalogueApi.sync("changes"), "Sync started. Changes reach WhatsApp in about a minute.")}
          >
            <RefreshCw size={14} aria-hidden /> Sync now
          </button>
          <div className="cat-more">
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((o) => !o)}
            >
              <MoreHorizontal size={14} aria-hidden /> More
            </button>
            {moreOpen && (
              <div className="card cat-more__menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  disabled={!link.sync_enabled}
                  onClick={() => {
                    setMoreOpen(false);
                    setConfirm("full");
                  }}
                >
                  Send everything again
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false);
                    setConfirm("unlink");
                  }}
                >
                  Disconnect this catalogue
                </button>
              </div>
            )}
          </div>
        </div>

        {items.isLoading ? (
          <InlineLoader />
        ) : items.error ? (
          <div className="empty" style={{ display: "grid", gap: 12, justifyItems: "center" }}>
            <div>We couldn&apos;t load the catalogue. Check your connection and try again.</div>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => void items.refetch()}>
              Try again
            </button>
          </div>
        ) : shown.length === 0 ? (
          <div className="empty">
            {total === 0 && !q && filter === "all"
              ? "No juices yet. Add flavours and sizes in the shop admin and they will appear here."
              : "Nothing matches."}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table ibx-stack">
              <thead>
                <tr>
                  <th>Juice</th>
                  <th className="table__num">Price</th>
                  <th>Stock</th>
                  <th>On WhatsApp</th>
                  <th>Last sent</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => {
                  const tone = stateTone(item.state);
                  const needsPerson = item.state === "rejected" || item.state === "blocked";
                  return (
                    <tr key={item.id}>
                      <td>
                        <div className="cat-item">
                          {item.picture_url ? (
                            <img className="cat-thumb" src={item.picture_url} alt="" loading="lazy" />
                          ) : (
                            <div className="cat-thumb" aria-hidden />
                          )}
                          <div style={{ minWidth: 0 }}>
                            <div className="cat-item__title">{item.title}</div>
                            {needsPerson && (
                              <div className="cat-item__why">
                                {item.problem_plain}{" "}
                                <button type="button" className="cat-link" onClick={() => setWhy(item)}>
                                  Why?
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="table__num" data-label="Price">
                        {item.price_ngn != null ? formatNaira(item.price_ngn) : "—"}
                      </td>
                      <td data-label="Stock">{stockLabel(item.availability) || "—"}</td>
                      <td data-label="On WhatsApp">
                        <span className={tone === "off" ? "pill" : `pill pill--${tone}`}>{stateLabel(item.state)}</span>
                      </td>
                      <td data-label="Last sent">{lagosTime(item.pushed_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {confirm === "connect" && (
        <ConnectCatalogueDialog
          name={link.name ?? `catalogue ${link.catalog_id}`}
          busy={busy === "connect"}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void connectWhatsApp()}
        />
      )}
      {confirm === "full" && (
        <ConfirmModal
          title="Send everything again?"
          confirmLabel="Send everything again"
          busyLabel="Starting…"
          busy={busy === "full"}
          onCancel={() => setConfirm(null)}
          onConfirm={() =>
            void run("full", () => catalogueApi.sync("full"), "Sync started. Changes reach WhatsApp in about a minute.").then(() => setConfirm(null))
          }
        >
          <p style={{ margin: 0 }}>
            Send all {sendable} items to Meta again? Use this only if WhatsApp looks wrong. It can take a few minutes.
          </p>
        </ConfirmModal>
      )}
      {confirm === "unlink" && (
        <ConfirmModal
          title="Disconnect this catalogue?"
          confirmLabel="Disconnect"
          busyLabel="Disconnecting…"
          tone="danger"
          busy={busy === "unlink"}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void run("unlink", () => catalogueApi.unlink(), "Catalogue disconnected.").then(() => setConfirm(null))}
        >
          <p style={{ margin: 0 }}>
            Stop syncing and forget this catalogue? Items already in Meta stay there until you delete them in Commerce Manager.
          </p>
        </ConfirmModal>
      )}
      {why && <ItemProblemDialog item={why} busy={busy === `retry:${why.id}`} onClose={() => setWhy(null)} onRetry={() => void retry(why)} />}
    </>
  );
}

function SwitchRow({
  label,
  checked,
  busy,
  disabled = false,
  help,
  warning,
  onChange,
}: {
  label: string;
  checked: boolean;
  busy: boolean;
  disabled?: boolean;
  help?: string | undefined;
  warning?: string | undefined;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <div className="cat-row">
      <label className="cat-switch" style={{ flex: "1 1 260px", opacity: disabled ? 0.7 : 1 }}>
        <input type="checkbox" role="switch" checked={checked} disabled={disabled || busy} onChange={(e) => onChange(e.target.checked)} />
        <span className="cat-row__text">
          <span className="cat-row__label">{label}</span>
          {help && <span className="cat-fine">{help}</span>}
          {warning && (
            <span className="cat-fine" style={{ color: "#92400e" }}>
              {warning}
            </span>
          )}
        </span>
      </label>
    </div>
  );
}
