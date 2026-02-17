import { VodPage } from './VodPage';
import type { VodPlayInfo } from '../types/media';

interface MoviesPageProps {
  onPlay?: (info: VodPlayInfo) => void;
  onClose?: () => void;
}

export function MoviesPage({ onPlay, onClose }: MoviesPageProps) {
  return <VodPage type="movie" onPlay={onPlay} onClose={onClose} />;
}

export default MoviesPage;
