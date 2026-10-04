import type { Metadata } from "next";
import { AnonymousAnalytics } from "@/components/anonymous-analytics";
import "./globals.css";

export const metadata: Metadata = {
  title: "ConvertHub AI — Files, effortlessly transformed",
  description: "The beautifully simple workspace for every file conversion. Convert documents, images, audio and video in seconds.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}<AnonymousAnalytics /></body></html>;
}
