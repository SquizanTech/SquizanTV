import { useEffect, useRef, useState, type ReactNode } from 'react'

interface VirtualGridProps<T> {
  items: T[]
  minColumnWidth: number
  rowHeight: number
  gap?: number
  renderItem: (item: T, index: number) => ReactNode
  empty?: ReactNode
  className?: string
}

export function VirtualGrid<T>({
  items,
  minColumnWidth,
  rowHeight,
  gap = 12,
  renderItem,
  empty,
  className,
}: VirtualGridProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) setSize({ width: rect.width, height: rect.height })
    })
    observer.observe(element)
    setSize({ width: element.clientWidth, height: element.clientHeight })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setScrollTop(0)
    containerRef.current?.scrollTo({ top: 0 })
  }, [items])

  if (items.length === 0) {
    return <div className={`vgrid-empty ${className ?? ''}`}>{empty}</div>
  }

  const columns = Math.max(1, Math.floor((size.width + gap) / (minColumnWidth + gap)))
  const rowStride = rowHeight + gap
  const totalRows = Math.ceil(items.length / columns)
  const firstRow = Math.max(0, Math.floor(scrollTop / rowStride) - 1)
  const visibleRows = Math.ceil((size.height || 600) / rowStride) + 2
  const lastRow = Math.min(totalRows, firstRow + visibleRows)

  const rows: ReactNode[] = []
  for (let row = firstRow; row < lastRow; row++) {
    const start = row * columns
    const slice = items.slice(start, start + columns)
    rows.push(
      <div
        key={row}
        className="vgrid-row"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap,
          height: rowHeight,
        }}
      >
        {slice.map((item, index) => renderItem(item, start + index))}
      </div>,
    )
  }

  return (
    <div
      ref={containerRef}
      className={`vgrid ${className ?? ''}`}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div style={{ height: totalRows * rowStride, position: 'relative' }}>
        <div style={{ transform: `translateY(${firstRow * rowStride}px)` }}>{rows}</div>
      </div>
    </div>
  )
}
