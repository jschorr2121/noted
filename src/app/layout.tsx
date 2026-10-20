import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Noted — Video to Notes",
  description: "Upload a video, get comprehensive meeting or lecture notes",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `try{if(localStorage.theme==="dark")document.documentElement.classList.add("dark")}catch(e){}` }} />
      </head>
      <body className={`${inter.className} bg-neutral-950 text-neutral-100 min-h-screen`}>
        {children}
      </body>
    </html>
  );
}
