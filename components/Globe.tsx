"use client";

import { useEffect, useRef } from "react";
import createGlobe from "cobe";

export function Globe({
  latitude,
  longitude,
  lightMode,
  size = 600,
}: {
  latitude: number;
  longitude: number;
  lightMode: boolean;
  size?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phiRef = useRef(0);
  const thetaRef = useRef(0);
  const targetRef = useRef({ lat: latitude, lon: longitude });

  useEffect(() => {
    targetRef.current = { lat: latitude, lon: longitude };
  }, [latitude, longitude]);

  useEffect(() => {
    if (!canvasRef.current) return;

    const targetPhi = () =>
      -((targetRef.current.lon * Math.PI) / 180) - Math.PI / 2;
    const targetTheta = () =>
      (targetRef.current.lat * Math.PI) / 180;

    phiRef.current = targetPhi();
    thetaRef.current = targetTheta();

    const globe = createGlobe(canvasRef.current, {
      devicePixelRatio: Math.min(window.devicePixelRatio, 2),
      width: size * 2,
      height: size * 2,
      phi: phiRef.current,
      theta: thetaRef.current,
      dark: lightMode ? 0 : 1,
      diffuse: lightMode ? 2.0 : 1.4,
      mapSamples: 40000,
      mapBrightness: lightMode ? 2.2 : 8,
      mapBaseBrightness: lightMode ? 0.05 : 0.02,
      baseColor: lightMode ? [0.93, 0.95, 0.97] : [0.12, 0.17, 0.24],
      markerColor: lightMode ? [0.04, 0.5, 0.64] : [0.41, 0.86, 1.0],
      glowColor: lightMode ? [0.82, 0.88, 0.94] : [0.06, 0.12, 0.2],
      markers: [{ location: [latitude, longitude], size: 0.1 }],
      scale: 1.02,
    });

    let rafId: number;
    const animate = () => {
      const tp = targetPhi();
      const tt = targetTheta();

      let dPhi = tp - phiRef.current;
      while (dPhi > Math.PI) dPhi -= 2 * Math.PI;
      while (dPhi < -Math.PI) dPhi += 2 * Math.PI;
      phiRef.current += dPhi * 0.04;
      thetaRef.current += (tt - thetaRef.current) * 0.04;

      globe.update({
        phi: phiRef.current,
        theta: thetaRef.current,
        markers: [
          {
            location: [targetRef.current.lat, targetRef.current.lon],
            size: 0.1,
          },
        ],
      });

      rafId = requestAnimationFrame(animate);
    };
    rafId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafId);
      globe.destroy();
    };
  }, [lightMode, size]);

  return (
    <div className="globe-wrapper" style={{ width: size, height: size }}>
      <canvas
        ref={canvasRef}
        className="cobe-globe"
        width={size * 2}
        height={size * 2}
        style={{ width: size, height: size }}
      />
      {/* Satellite overlay — always centered since globe rotates to face it */}
      <div className="satellite-marker" aria-label="Satellite position">
        <span className="marker-dot" />
        <span className="marker-ring" />
        <span className="marker-ping" />
        <span className="marker-ping marker-ping-delayed" />
      </div>
    </div>
  );
}
