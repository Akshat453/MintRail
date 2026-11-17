"use client";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="card">
      <h2>Something went wrong</h2>
      <p className="muted">
        {error.digest ? `Reference ${error.digest}. ` : ""}Try again, or contact MintRail support if it keeps happening.
      </p>
      <button onClick={reset}>Try again</button>
    </section>
  );
}
