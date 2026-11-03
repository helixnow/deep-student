import { editorRegistry } from '@/dstu/editorRegistry';
import type { EditorComponent } from '@/dstu/editorTypes';

let registered = false;

export function registerDstuFileViewer(): void {
  if (registered) return;
  registered = true;
  editorRegistry.file.editor = () => import('./DstuFileViewer').then(({ DstuFileViewer }) => ({
    default: DstuFileViewer as EditorComponent,
  }));
}
