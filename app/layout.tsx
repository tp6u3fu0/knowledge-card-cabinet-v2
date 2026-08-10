import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "知識卡冊｜研究中的收藏",
  description: "把複雜的知識，收藏成一張張可以回來閱讀的卡片。",
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
