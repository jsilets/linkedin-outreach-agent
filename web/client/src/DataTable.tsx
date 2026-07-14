import { type ReactNode, useMemo, useState } from 'react';
import { readPref, writePref } from './prefs';

// A generic, sortable, client-paginated table. Sort and page state live in the
// component and survive parent refetches (e.g. after an approval reloads leads):
// nothing here is keyed off the data array, so a new `rows` reference re-renders
// with the same sort column and page. Rows are matched by `rowKey`, so identity
// is stable across reloads too. Pass `search` to add a text filter above the table.
// Pass `persistKey` to also remember sort + filter across visits (localStorage).

export type SortValue = string | number | null | undefined;

export interface Column<T> {
  key: string;
  header: ReactNode;
  // Value used for sorting. Return null/undefined to sort a row to the end.
  sortValue?: (row: T) => SortValue;
  // How the cell renders. Defaults to String(sortValue).
  cell: (row: T) => ReactNode;
  // Right-align + tabular figures for numeric columns.
  numeric?: boolean;
  // Set false to make a column non-sortable (no clickable header).
  sortable?: boolean;
  // Extra class on the <td>.
  cellClassName?: string;
}

type Dir = 'asc' | 'desc';

const PAGE_SIZE = 25;

function compare(a: SortValue, b: SortValue): number {
  const aEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1; // empties always sort last, regardless of direction
  if (bEmpty) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  rowClassName,
  initialSort,
  search,
  searchPlaceholder = 'Filter…',
  persistKey,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  rowClassName?: (row: T) => string | undefined;
  initialSort?: { key: string; dir: Dir };
  // Provide a text accessor to render a filter box; rows are matched by substring.
  search?: (row: T) => string;
  searchPlaceholder?: string;
  // Namespace for remembering sort + filter across visits. Omit for ephemeral state.
  persistKey?: string;
}) {
  const [sort, setSortState] = useState<{ key: string; dir: Dir } | null>(() =>
    persistKey ? readPref(`${persistKey}.sort`, initialSort ?? null) : (initialSort ?? null),
  );
  const [page, setPage] = useState(0);
  const [query, setQueryState] = useState(() =>
    persistKey ? readPref(`${persistKey}.q`, '') : '',
  );

  function setSort(
    update: (prev: { key: string; dir: Dir } | null) => { key: string; dir: Dir } | null,
  ) {
    setSortState((prev) => {
      const next = update(prev);
      if (persistKey) writePref(`${persistKey}.sort`, next);
      return next;
    });
  }

  function setQuery(q: string) {
    setQueryState(q);
    if (persistKey) writePref(`${persistKey}.q`, q);
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !search) return rows;
    return rows.filter((row) => search(row).toLowerCase().includes(q));
  }, [rows, query, search]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return filtered;
    const getVal = col.sortValue;
    const dir = sort.dir === 'asc' ? 1 : -1;
    // Stable sort on a copy; empties stay last via compare(), not flipped by dir.
    return [...filtered].sort((a, b) => {
      const cmp = compare(getVal(a), getVal(b));
      if (cmp === 0) return 0;
      const aEmpty = getVal(a) === null || getVal(a) === undefined;
      const bEmpty = getVal(b) === null || getVal(b) === undefined;
      if (aEmpty || bEmpty) return cmp; // keep empties last irrespective of dir
      return cmp * dir;
    });
  }, [filtered, columns, sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  // Clamp during render so a shrunk dataset can't strand us on an empty page,
  // without a state write that would fight the "state survives refetch" rule.
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * PAGE_SIZE;
  const visible = sorted.slice(start, start + PAGE_SIZE);

  function toggleSort(col: Column<T>) {
    if (col.sortable === false || !col.sortValue) return;
    setSort((prev) => {
      if (!prev || prev.key !== col.key) return { key: col.key, dir: 'asc' };
      if (prev.dir === 'asc') return { key: col.key, dir: 'desc' };
      return null; // asc -> desc -> unsorted
    });
  }

  function ariaSort(col: Column<T>): 'ascending' | 'descending' | 'none' {
    if (!sort || sort.key !== col.key) return 'none';
    return sort.dir === 'asc' ? 'ascending' : 'descending';
  }

  return (
    <div className="data-table">
      {search && (
        <div className="dt-toolbar">
          <input
            type="search"
            className="dt-search"
            value={query}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
          {query.trim() && (
            <span className="dt-range">
              {sorted.length} {sorted.length === 1 ? 'match' : 'matches'}
            </span>
          )}
        </div>
      )}
      <table>
        <thead>
          <tr>
            {columns.map((col) => {
              const canSort = col.sortable !== false && Boolean(col.sortValue);
              const sortState = ariaSort(col);
              const indicator =
                sortState === 'ascending' ? '↑' : sortState === 'descending' ? '↓' : '↕';
              return (
                <th
                  key={col.key}
                  className={canSort ? 'sortable' : undefined}
                  aria-sort={canSort ? sortState : undefined}
                >
                  {canSort ? (
                    <button
                      type="button"
                      className={`dt-th${col.numeric ? ' num' : ''}`}
                      aria-sort={sortState}
                      onClick={() => toggleSort(col)}
                    >
                      {col.header}
                      <span className="dt-sort" aria-hidden="true">
                        {indicator}
                      </span>
                    </button>
                  ) : (
                    <span className={`dt-th${col.numeric ? ' num' : ''}`}>{col.header}</span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => (
            <tr key={rowKey(row)} className={rowClassName?.(row)}>
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={
                    [col.numeric ? 'num' : '', col.cellClassName ?? ''].filter(Boolean).join(' ') ||
                    undefined
                  }
                >
                  {col.cell(row)}
                </td>
              ))}
            </tr>
          ))}
          {visible.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="muted">
                {query.trim() ? 'No matches.' : 'Nothing here yet.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {pageCount > 1 && (
        <div className="dt-pager">
          <span className="dt-range">
            {start + 1}–{Math.min(start + PAGE_SIZE, sorted.length)} of {sorted.length}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn ghost tiny"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}
          >
            Prev
          </button>
          <button
            type="button"
            className="btn ghost tiny"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={safePage >= pageCount - 1}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
