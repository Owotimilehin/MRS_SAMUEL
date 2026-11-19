import { Facebook, Instagram, MessageCircle, Phone } from "lucide-react";
import type { IdentityChannel } from "../../lib/inbox-types.js";

const TITLES: Record<IdentityChannel, string> = {
  whatsapp: "WhatsApp",
  messenger: "Facebook Messenger",
  instagram: "Instagram",
};

/** The small mark that says where a chat came from (suite spec 02, 7.1). */
export function ChannelIcon({
  channel,
  callsOnly = false,
  size = 12,
}: {
  channel: IdentityChannel | undefined;
  callsOnly?: boolean;
  size?: number;
}): JSX.Element {
  const title = callsOnly ? "Phone calls" : TITLES[channel ?? "whatsapp"];
  const Icon = callsOnly ? Phone : channel === "messenger" ? Facebook : channel === "instagram" ? Instagram : MessageCircle;
  return (
    <span className="ibx-channel-icon" title={title} role="img" aria-label={title} style={{ display: "inline-flex" }}>
      <Icon size={size} aria-hidden />
    </span>
  );
}
