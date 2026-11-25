import GameClient from './GameClient';

export function generateStaticParams() {
  return ['rov', 'mobile-legends', 'genshin-impact', 'free-fire', 'valorant', 'delta-force'].map(slug => ({ slug }));
}

export default function GamePage({ params }: { params: Promise<{ slug: string }> }) {
  return <GameClient params={params} />;
}
