import { Suspense, use } from "preact/compat";

export function App() {
  const profileName = new Promise<string>((resolve) =>
    setTimeout(() => resolve("Ada Lovelace"), 800),
  );

  return (
    <main>
      <h1>Promise props</h1>
      <Suspense fallback={<p>Loading profile…</p>}>
        <ProfileCard name={profileName} />
      </Suspense>
    </main>
  );
}

function ProfileCard({ name }: { name: Promise<string> }) {
  "use client";

  return <p>Hello, {use(name)}.</p>;
}
