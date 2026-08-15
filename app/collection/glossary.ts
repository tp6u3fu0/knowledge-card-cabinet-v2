import type { CoverMotif } from "../cover-art";
import type { VisualAccent } from "./types";

export type GlossaryEntry = {
  id: string;
  number: string;
  term: string;
  question: string;
  answer: string;
  aside?: string;
  accent: VisualAccent;
  glyph: CoverMotif["shape"];
  /** Which settings tab this term belongs beside. */
  scope: "local" | "api" | "data" | "devices";
};

/**
 * The words this settings page uses that nobody is born knowing.
 *
 * Written for someone who has never trained anything: no jargon in the answer
 * unless the answer is about that jargon, and every entry says what it changes
 * *for them* rather than what it is in the abstract. The `aside` is the part a
 * curious reader wants second, not a footnote that repeats the first line.
 */
export const GLOSSARY: GlossaryEntry[] = [
  {
    id: "embedding",
    number: "G-01",
    term: "語意向量",
    question: "電腦怎麼知道兩張卡片講的是類似的事？",
    answer: "它會把每張卡片的文字換算成一串數字，意思相近的卡片，數字也會靠得比較近。搜尋、關聯圖、「相關卡片」都是靠這串數字算出來的，不是靠關鍵字比對。",
    aside: "所以就算兩張卡片一個字都沒重複，只要在講同一件事，還是會被連起來。",
    accent: "sky",
    glyph: "constellation",
    scope: "local",
  },
  {
    id: "dimensions",
    number: "G-02",
    term: "維度",
    question: "384 維和 1024 維差在哪？",
    answer: "就是上面那串數字有多長。1024 維記得比較細，分辨相近主題時比較準；384 維檔案小、算得快，日常用通常就夠了。",
    aside: "重點是整個卡冊只能用同一種長度。換維度等於把所有卡片的數字重算一次，卡片內容不會變，但要花一點時間。",
    accent: "indigo",
    glyph: "bars",
    scope: "local",
  },
  {
    id: "summary-model",
    number: "G-03",
    term: "整理模型",
    question: "貼上一段筆記後，是誰幫我拆成卡片欄位的？",
    answer: "整理模型。你貼一段雜亂的筆記，它負責讀完後填出標題、問題、摘要、比喻這些欄位，讓你只要檢查和修改，不用從空白開始寫。",
    aside: "模型越大讀得越懂上下文，但下載更久、每次整理也更慢。這個隨時可以換，換了不影響已經存好的卡片。",
    accent: "amber",
    glyph: "steps",
    scope: "local",
  },
  {
    id: "onnx",
    number: "G-04",
    term: "ONNX",
    question: "為什麼有些模型加不進來？",
    answer: "ONNX 是一種模型的存檔格式。這個程式在你電腦上跑模型時只讀得懂這種格式，所以 Hugging Face 上沒有轉成 ONNX 的模型就用不了。",
    aside: "找 Xenova 或 onnx-community 這兩個帳號轉過的版本通常都可以。加入清單時會先幫你檢查，不會等到下載完才發現。",
    accent: "moss",
    glyph: "nested",
    scope: "local",
  },
  {
    id: "local-vs-api",
    number: "G-05",
    term: "本機與 API",
    question: "模型跑在哪裡，有什麼差別？",
    answer: "本機是用你自己的電腦算，卡片內容完全不離開這台機器，但速度受限於你的 CPU。API 是把文字送到別的服務去算，通常更快更聰明，代價是內容會離開這台電腦。",
    aside: "Ollama 和 LM Studio 雖然也是填 API 位址，但它們就跑在你自己的電腦上，內容一樣不會外流。",
    accent: "lavender",
    glyph: "link",
    scope: "api",
  },
  {
    id: "api-dimensions",
    number: "G-06",
    term: "維度驗證",
    question: "怎麼確認我接的 API 真的回傳 1024 維？",
    answer: "沒辦法用看的。服務的模型清單只會告訴你名字，不會說向量有多長，所以要實際送一小段文字過去，數數看回來幾個數字。",
    aside: "旁邊的「測量維度」就是在做這件事，並且會告訴你這個寬度跟你現有的卡片合不合。不合的話存下去會需要重建全部向量。",
    accent: "rose",
    glyph: "target",
    scope: "api",
  },
  {
    id: "pairing",
    number: "G-07",
    term: "配對碼",
    question: "手機是怎麼取得存取權的？",
    answer: "電腦產生一組只能用一次的配對碼，手機輸入之後，會拿到一把只屬於它自己的鑰匙。電腦這邊不會顯示也不會保存那把鑰匙。",
    aside: "所以撤銷某一台手機不會影響其他台。配對碼十分鐘後失效，而且用過一次就作廢。",
    accent: "rose",
    glyph: "crosshair-box",
    scope: "devices",
  },
  {
    id: "fingerprint",
    number: "G-08",
    term: "憑證指紋",
    question: "畫面上那一長串英數字是什麼？",
    answer: "是這台電腦自己簽發的連線憑證的指紋。手機第一次連進來時要核對它，確認自己連到的真的是你這台電腦，而不是同一個網路上假冒的機器。",
    aside: "因為憑證是自己簽的，作業系統不會認證它，所以核對指紋這一步不能省。",
    accent: "indigo",
    glyph: "crosshair",
    scope: "devices",
  },
  {
    id: "backup",
    number: "G-09",
    term: "匯出與校驗碼",
    question: "匯出的檔案裡那個 checksum 是做什麼的？",
    answer: "是整份資料的指紋，用來確認檔案在搬運過程中沒有損壞。匯入時會先比對，不一致就不會蓋掉你現在的卡片。",
    aside: "如果這份備份是別的工具產生的，把 checksum 欄位刪掉再匯入即可——不同程式算小數的方式不一樣，校驗碼本來就不能跨工具比。",
    accent: "moss",
    glyph: "folder",
    scope: "data",
  },
];

export function glossaryFor(scope: GlossaryEntry["scope"]): GlossaryEntry[] {
  return GLOSSARY.filter((entry) => entry.scope === scope);
}
