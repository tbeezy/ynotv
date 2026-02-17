import { VodPage } from './VodPage';
import type { VodPlayInfo } from '../types/media';

interface SeriesPageProps {
  onPlay?: (info: VodPlayInfo) => void;
  onClose?: () => void;
}

export function SeriesPage({ onPlay, onClose }: SeriesPageProps) {
  return <VodPage type="series" onPlay={onPlay} onClose={onClose} />;
}

export default SeriesPage;
