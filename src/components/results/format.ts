export function money(value: number, currency = 'USD'): string {
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  try {
    return formatter.format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function percent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function confidenceLabel(value: number): string {
  if (value >= 0.9999) return '99.99%';
  return `${(value * 100).toFixed(2)}%`;
}

export function count(value: number): string {
  return value.toLocaleString('en-US');
}

export const VISIBILITY_STYLE: Record<string, { label: string; className: string }> = {
  HIDDEN: { label: 'Hidden', className: 'text-[var(--good)] border-[color-mix(in_srgb,var(--good)_40%,var(--line))]' },
  LIKELY_HIDDEN: { label: 'Likely hidden', className: 'text-[var(--good)] border-[color-mix(in_srgb,var(--good)_28%,var(--line))]' },
  UNCERTAIN: { label: 'Uncertain', className: 'text-[var(--warn)] border-[color-mix(in_srgb,var(--warn)_35%,var(--line))]' },
  LIKELY_VISIBLE: { label: 'Likely visible', className: 'text-[var(--warn)] border-[color-mix(in_srgb,var(--warn)_35%,var(--line))]' },
  VISIBLE: { label: 'Visible', className: 'text-[var(--bad)] border-[color-mix(in_srgb,var(--bad)_35%,var(--line))]' },
};
