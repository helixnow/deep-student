import { Composition } from 'remotion';
import { FPS, HEIGHT, PACE, WIDTH } from './lib/time';
import { Gallery, GALLERY_PAGES } from './app-ui/Gallery';
import { ALL_INSERTS } from './inserts';
import { PV } from './PV';
import { InsertPreview } from './timeline/InsertPreview';
import { TOTAL_SCRIPT_S } from './timeline/schedule';

export const Root = () => (
  <>
    <Composition id="DeepStudentPV" component={PV} durationInFrames={Math.round(TOTAL_SCRIPT_S * PACE * FPS)} fps={FPS} width={WIDTH} height={HEIGHT} />
    <Composition id="AppUiGallery" component={Gallery} durationInFrames={GALLERY_PAGES} fps={FPS} width={WIDTH} height={HEIGHT} />
    {ALL_INSERTS.map((insert) => (
      <Composition
        key={insert.id}
        id={`Insert-${insert.id}`}
        component={InsertPreview}
        defaultProps={{ id: insert.id }}
        durationInFrames={Math.max(1, Math.round(insert.dur * PACE * FPS))}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
    ))}
  </>
);
