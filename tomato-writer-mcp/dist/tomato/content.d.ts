/** 章节正文处理：纯文本/Markdown → 番茄要求的 <p> 段落 HTML；从 md 稿件提取指定章。 */
/**
 * 文本转番茄正文 HTML。
 * - 已经是 <p> 开头的视为现成 HTML，原样返回；
 * - 否则按行切分，每个非空行作为一个段落，去掉 Markdown 加粗标记 **。
 */
export declare function toChapterHtml(text: string): string;
export interface ExtractedChapter {
    /** 完整标题，如「第16章 一炉好丹」 */
    title: string;
    /** 正文 HTML */
    content: string;
    /** 段落数 */
    paragraphs: number;
}
/**
 * 从 Markdown 稿件里提取指定章节号。约定章节标题形如 `## 第N章 标题`。
 */
export declare function extractChapter(filePath: string, chapterNo: number): ExtractedChapter;
