import { Suspense, use } from "preact/compat";

function SlowGreeting({ greeting }: { greeting: Promise<string> }) {
  return <p>{use(greeting)}</p>;
}

export function App() {
  const greeting = new Promise<string>((resolve) =>
    setTimeout(() => resolve("Hello after the wait."), 1000),
  );

  return (
    <main>
      <h1>Async data</h1>
      {/* TODO: Show a fallback while SlowGreeting loads. */}
      <SlowGreeting greeting={greeting} />
    </main>
  );
}
