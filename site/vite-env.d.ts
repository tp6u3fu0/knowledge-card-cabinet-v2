/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the desktop build can be downloaded, if it has been published. */
  readonly VITE_KCC_DOWNLOAD_URL?: string;
  /** A hosted copy of the cabinet itself, if one is running somewhere public. */
  readonly VITE_KCC_APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
