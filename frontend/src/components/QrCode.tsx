import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

interface QrCodeProps {
  value: string;
  size?: number;
  /** Accessible fallback text shown when rendering fails. */
  fallbackText?: string;
}

/**
 * Renders a QR code to a canvas. The frame keeps a white background and a
 * quiet zone (margin) regardless of theme so scanners always get contrast.
 */
export function QrCode({ value, size = 208, fallbackText }: QrCodeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setFailed(false);
    QRCode.toCanvas(canvas, value, {
      margin: 2, // quiet zone
      width: size,
      errorCorrectionLevel: 'M',
      color: { dark: '#0d1512', light: '#ffffff' },
    }).catch(() => setFailed(true));
  }, [value, size]);

  if (failed) {
    return (
      <div className="qr-frame" data-testid="qr-fallback">
        <p className="dropzone-sub">QR code unavailable — use the room code below.</p>
        {fallbackText ? <p className="room-code">{fallbackText}</p> : null}
      </div>
    );
  }

  return (
    <div className="qr-frame">
      <canvas ref={canvasRef} role="img" aria-label={`QR code linking to ${value}`} />
    </div>
  );
}
