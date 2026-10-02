export function App() {
  return (
    <main>
      <h1>Event handlers</h1>
      <p>This button is dead. Give it a client handler.</p>
      <GreetButton name="Ada" />
    </main>
  );
}

function GreetButton({ name }: { name: string }) {
  const handleClick = () => {
    "use client";

    alert(`Hello, ${name}!`);
  };
  return <button onClick={handleClick}>Greet</button>;
}
