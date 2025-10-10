declare namespace chrome {
  namespace offscreen {
    type Reason = 'AUDIO_PLAYBACK' | 'BLOBS' | 'DOM_PARSER' | 'DOM_SCRAPING' | 'IFRAME_SCRIPTING' | 'TESTING';

    interface CreateDocumentOptions {
      justification: string;
      reasons: Reason[];
      url: string;
    }

    function createDocument(options: CreateDocumentOptions): Promise<void> | void;
    function closeDocument(): Promise<void> | void;
    function hasDocument(): Promise<boolean> | boolean;
  }
}
