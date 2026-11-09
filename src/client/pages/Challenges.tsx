import { useState } from "react";
import { Link } from "react-router";
import { ChallengeCard } from "../components/ChallengeCard";
import { ChallengeDialog } from "../components/ChallengeDialog";
import { useLobby } from "../lib/lobby";
import { useMe } from "../lib/me";
import { useOpenChallenges } from "./Players";

export function Challenges() {
  const { me } = useMe();
  const { challenges } = useLobby();
  const open = useOpenChallenges().filter((c) => c.from.id !== me?.user?.id);
  const [dialog, setDialog] = useState(false);

  if (me && !me.user)
    return (
      <div className="page center">
        <h1>Challenges</h1>
        <p className="muted">Sign in to challenge players and schedule games.</p>
        <Link className="btn primary" to="/signin?next=/challenges">
          Sign in
        </Link>
      </div>
    );

  const section = (title: string, list: typeof challenges.incoming, empty: string) => (
    <section>
      <h2>
        {title} {list.length > 0 && <span className="count">{list.length}</span>}
      </h2>
      {list.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <div className="challenge-list">
          {list.map((c) => (
            <ChallengeCard key={c.id} c={c} />
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div className="page">
      <div className="page-head">
        <h1>Challenges</h1>
        <button className="btn primary" onClick={() => setDialog(true)}>
          New challenge
        </button>
      </div>
      {section("Incoming", challenges.incoming, "No one has challenged you. Challenges arrive here and as a notification on any page.")}
      {section("Upcoming scheduled games", challenges.upcoming, "No scheduled games. Schedule one with a player, or post one for anyone.")}
      {section("Sent", challenges.outgoing, "You have no pending challenges.")}
      {section("Open challenges from others", open, "None right now.")}
      {challenges.started.length > 0 && section("Recently started", challenges.started, "")}
      {dialog && <ChallengeDialog onClose={() => setDialog(false)} />}
    </div>
  );
}
