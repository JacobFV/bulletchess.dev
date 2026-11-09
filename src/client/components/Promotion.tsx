import type { Color } from "../../shared/protocol";

const ROLES = [
  ["q", "queen"],
  ["n", "knight"],
  ["r", "rook"],
  ["b", "bishop"],
] as const;

export function PromotionPicker({ color, onPick, onCancel }: { color: Color; onPick: (r: "q" | "r" | "b" | "n") => void; onCancel: () => void }) {
  return (
    <div className="promo-overlay" onClick={onCancel} role="dialog" aria-label="Choose promotion piece">
      <div className="promo" onClick={(e) => e.stopPropagation()}>
        {ROLES.map(([r, name]) => (
          <button key={r} className="promo-btn cg-wrap" onClick={() => onPick(r)} aria-label={name} autoFocus={r === "q"}>
            <piece className={`${name} ${color}`} />
          </button>
        ))}
      </div>
    </div>
  );
}

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      piece: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}
