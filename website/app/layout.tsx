import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://lengjinyang.github.io/Yoiniwa/'),
  title: 'Yoiniwa · 宵庭 — 为视觉创作者打造的参考图画板',
  description: 'Yoiniwa 是一款面向插画与视觉创作的 Windows 参考图画板。无限画布、本地存储，并支持 Photoshop 协作。',
  icons: { icon: 'https://lengjinyang.github.io/Yoiniwa/yoiniwa-icon.png' },
  openGraph: {
    title: 'Yoiniwa · 宵庭',
    description: '为视觉创作者打造的参考图画板',
    images: [{ url: 'https://lengjinyang.github.io/Yoiniwa/og.png', width: 1200, height: 630, alt: 'Yoiniwa · 宵庭' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Yoiniwa · 宵庭',
    description: '为视觉创作者打造的参考图画板',
    images: ['https://lengjinyang.github.io/Yoiniwa/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
