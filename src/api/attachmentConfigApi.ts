import { invoke } from '@tauri-apps/api/core';

export interface AttachmentConfig {
  attachmentRootFolderId: string | null;
  attachmentRootFolderTitle: string | null;
}

export const attachmentConfigApi = {
  async getConfig(): Promise<AttachmentConfig> {
    return invoke('vfs_get_attachment_config');
  },

  async setRootFolder(folderId: string): Promise<void> {
    return invoke('vfs_set_attachment_root_folder', { folderId });
  },

  async createRootFolder(title: string): Promise<string> {
    return invoke('vfs_create_attachment_root_folder', { title });
  },
};

export default attachmentConfigApi;
