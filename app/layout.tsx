import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  // The window title, so it is the product's name in the taskbar and the dock.
  // It said 研究中的收藏 until 1.2.0 — a collection in progress, which is the
  // positioning the front page dropped (CLAUDE.md §1). Missed then because
  // POS-001 named the landing page and this lives in the app.
  title: "知識卡冊｜慢慢理解，快速想起",
  description: "即使只剩模糊印象，也能在自己的裝置上快速搜尋，找回以前理解過的知識。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
