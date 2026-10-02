import { Suspense, use } from "preact/compat";

export function App() {
  const profileName = new Promise<string>((resolve) =>
    setTimeout(() => resolve("Ada Lovelace"), 800),
  );

  return (
    <main>
      <h1>Promise props</h1>
      {/* TODO: island + Suspense, so the name resolves in the browser. */}
      <ProfileCard name={profileName} />
    </main>
  );
}

function ProfileCard({ name }: { name: Promise<string> }) {
  // TODO: Add "use client" and read the promise with use().
  return <p>Hello, {String(name)}.</p>;
}
