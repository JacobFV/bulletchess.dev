import { Link } from "react-router";
import { signed } from "../lib/format";

export function PlayerTag({
  name,
  rating,
  provisional,
  diff,
  online,
  bot,
  link = true,
}: {
  name: string;
  rating?: number | null;
  provisional?: boolean;
  diff?: number | null;
  online?: boolean;
  bot?: boolean;
  link?: boolean;
}) {
  return (
    <span className="player-tag">
      {online !== undefined && <span className={`dot${online ? " on" : ""}`} title={online ? "Connected" : "Disconnected"} />}
      {bot || !link ? <span className="pname">{name}</span> : <Link className="pname" to={`/@/${encodeURIComponent(name)}`}>{name}</Link>}
      {rating != null && (
        <span className="prating">
          {rating}
          {provisional ? "?" : ""}
        </span>
      )}
      {diff != null && <span className={`pdiff ${diff > 0 ? "up" : diff < 0 ? "down" : ""}`}>{signed(diff)}</span>}
    </span>
  );
}
