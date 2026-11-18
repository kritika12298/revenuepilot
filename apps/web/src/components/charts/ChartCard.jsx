import { Table2, BarChart3 } from 'lucide-react';
import { useState } from 'react';
import { Card, CardHeader } from '../ui/Card.jsx';

/**
 * Card wrapper for charts with a chart/table toggle: every chart has a table
 * twin so no value is reachable only by hovering.
 */
export function ChartCard({ title, description, table, children, dim }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <Card className="flex flex-col">
      <CardHeader
        title={title}
        description={description}
        actions={
          <button
            type="button"
            onClick={() => setAsTable((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-ink"
            aria-pressed={asTable}
          >
            {asTable ? <BarChart3 className="h-3.5 w-3.5" aria-hidden /> : <Table2 className="h-3.5 w-3.5" aria-hidden />}
            {asTable ? 'Chart' : 'Table'}
          </button>
        }
      />
      <div className={`flex-1 ${dim ? 'opacity-60 transition-opacity' : 'transition-opacity'}`}>{asTable ? table : children}</div>
    </Card>
  );
}

export function DataTable({ columns, rows }) {
  return (
    <div className="max-h-80 overflow-y-auto px-5 py-3">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted">
            {columns.map((c) => (
              <th key={c.key} className={`pb-2 font-medium ${c.numeric ? 'text-right' : ''}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {columns.map((c) => (
                <td key={c.key} className={`py-1.5 ${c.numeric ? 'text-right tabular' : 'text-ink-2'}`}>
                  {r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
