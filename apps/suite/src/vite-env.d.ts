/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Address of the shop's admin app, for links out of the suite. Set at build time. */
  readonly VITE_ADMIN_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
