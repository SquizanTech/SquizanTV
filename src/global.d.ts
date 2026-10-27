import type { NovaApi } from '../electron/preload'

declare global {
  interface Window {
    nova: NovaApi
  }
}

export {}
