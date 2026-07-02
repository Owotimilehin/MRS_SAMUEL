export interface BannerConfig {
  enabled: boolean;
  message: string;
}

/** Custom banner wins when enabled and non-blank; otherwise null → fall back to auto. */
export function pickCustomBannerMessage(config: BannerConfig): string | null {
  if (!config.enabled) return null;
  const trimmed = config.message.trim();
  return trimmed.length > 0 ? trimmed : null;
}
