import Link from 'next/link';

export default function Home() {
  return (
    <main className="home">
      <h1>PaperWeave</h1>
      <p>
        The product is not built yet. The <Link href="/spike">editor spike</Link> shows the visual
        editor and the source editor working on one shared LaTeX file.
      </p>
    </main>
  );
}
