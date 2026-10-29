import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DiviWish · 息望｜每一笔股息都是未来的希望",
  description: "DiviWish 息望：A/H 股息率观察、自选管理、历史分位、股息率网格与除息日历。每一笔股息都是未来的希望。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
