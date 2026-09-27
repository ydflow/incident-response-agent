import { Activity } from 'lucide-react';

interface LogoLoadingProps {
  /** Show the product name below the mark. */
  full?: boolean;
  /** Size of the icon-only variant (default 64) */
  size?: number;
  /** Optional label below the logo */
  label?: string;
}

/** Product loading screen; runtime identifiers are unaffected. */
export function LogoLoading({ full, size = 64, label }: LogoLoadingProps) {
  if (full) {
    return (
      <div
        role="status"
        className="min-h-screen flex flex-col items-center justify-center"
        style={{ background: '#0d131c', color: '#e6edf5' }}
      >
        <Activity size={48} color="#60a5fa" aria-label="故障智巡" />
        <strong className="mt-4 text-xl">故障智巡</strong>
        {label && <p className="mt-6 text-sm text-muted-foreground">{label}</p>}
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-4"
      style={{ background: '#0d131c', color: '#e6edf5' }}
    >
      <Activity size={size} color="#60a5fa" aria-label="故障智巡" />
      {label && <p className="text-sm text-muted-foreground">{label}</p>}
    </div>
  );
}
