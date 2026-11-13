export type ImageAnalysisResult = {
  overallConcept: string; aspectRatio: string; reversePrompt: string; reversePromptTranslation: string;
  keywords: string[]; styleTags: string[];
};
export type ImageAnalysisItem = {
  index: number; status: 'queued' | 'running' | 'completed' | 'error' | 'interrupted';
  result: ImageAnalysisResult | null; error: string | null;
};
export type ImageAnalysisJob = { id: string; items: ImageAnalysisItem[] };
