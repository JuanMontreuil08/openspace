import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenSpace — Explore satellites in orbit",
  description:
    "A visual field guide to the satellites orbiting Earth, beginning with Starcloud-1.",
  openGraph: {
    title: "OpenSpace — Explore satellites in orbit",
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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
