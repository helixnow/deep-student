/** prost message subset in dstu-media/media/bilibili_transport/grpc.rs. */
export interface SubtitleTrack {
  lan: string;
  lan_doc: string;
  url: string;
  ai_mark: number;
  ai_from: number;
  ai_type: number;
}
export interface NativeProtobuf {
  encodeDmViewRequest(aid: bigint, cid: bigint): Uint8Array;
  /** `encoding`/`status` are the HTTP `content-encoding`/`grpc-status` headers Rust receives. */
  decodeDmViewReply(bytes: Uint8Array, encoding?: string | null, status?: string | null):
    { subtitle: { tracks: SubtitleTrack[] } | null };
}
declare module '@deepseek-ai/cordis' {
  interface Context { nativeProtobuf: NativeProtobuf }
}
