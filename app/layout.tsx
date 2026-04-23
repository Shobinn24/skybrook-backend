import "./globals.css";

export const metadata = {
  title: "Skybrook",
  description: "Everdries internal operations dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
