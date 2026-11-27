import type { ReactNode } from 'react'

// The browser always lays out, selects and announces this original text.
export function InkText({children}: {children: ReactNode}) {
  return <span className="ink-frame"><span className="ink-original">{children}</span></span>
}
