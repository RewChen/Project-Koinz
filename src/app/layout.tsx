import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'Koinz | เติมเกมออนไลน์ 24 ชั่วโมง', description: 'เติมเกมง่าย ปลอดภัย ไม่ต้องใช้รหัสผ่าน' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="th"><body>{children}</body></html>; }
