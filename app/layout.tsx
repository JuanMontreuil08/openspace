import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { SITE_NAME, THEME_STORAGE_KEY } from "@/lib/brand";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: `${SITE_NAME} — Explore satellites in orbit`,
  description:
    "A visual field guide to the satellites orbiting Earth, beginning with Starcloud-1.",
  openGraph: {
    title: `${SITE_NAME} — Explore satellites in orbit`,
    description:
      "A visual field guide to the satellites orbiting Earth, beginning with Starcloud-1.",
    type: "website",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Earth's horizon with a single satellite light in orbit",
      },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});document.documentElement.setAttribute("data-theme",t==="dark"?"dark":"light")}catch(e){document.documentElement.setAttribute("data-theme","light")}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
