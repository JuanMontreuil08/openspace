"use client";

import {
  motion,
  useReducedMotion,
  type Target,
  type TargetAndTransition,
  type Transition,
  type VariantLabels,
} from "motion/react";

export type TextRollProps = {
  children: string;
  duration?: number;
  getEnterDelay?: (index: number) => number;
  getExitDelay?: (index: number) => number;
  className?: string;
  transition?: Transition;
  variants?: {
    enter: {
      initial: Target | VariantLabels | boolean;
      animate: TargetAndTransition | VariantLabels;
    };
    exit: {
      initial: Target | VariantLabels | boolean;
      animate: TargetAndTransition | VariantLabels;
    };
  };
};

export function TextRoll({
  children,
  duration = 0.5,
  getEnterDelay = (index) => index * 0.1,
  getExitDelay = (index) => index * 0.1 + 0.2,
  className,
  transition = { ease: "easeIn" },
  variants,
}: TextRollProps) {
  const reduceMotion = useReducedMotion();
  if (reduceMotion) return <span className={className}>{children}</span>;

  const defaultVariants = {
    enter: { initial: { rotateX: 0 }, animate: { rotateX: 90 } },
    exit: { initial: { rotateX: 90 }, animate: { rotateX: 0 } },
  } as const;

  return (
    <span className={className}>
      {children.split("").map((letter, index) => (
        <span
          key={`${letter}-${index}`}
          className="relative inline-block overflow-hidden align-bottom [perspective:10000px] [transform-style:preserve-3d] [width:auto]"
          aria-hidden="true"
        >
          <motion.span
            className="absolute inline-block [backface-visibility:hidden] [transform-origin:50%_25%]"
            initial={variants?.enter.initial ?? defaultVariants.enter.initial}
            animate={variants?.enter.animate ?? defaultVariants.enter.animate}
            transition={{
              ...transition,
              duration,
              delay: getEnterDelay(index),
            }}
          >
            {letter === " " ? "\u00A0" : letter}
          </motion.span>
          <motion.span
            className="absolute inline-block [backface-visibility:hidden] [transform-origin:50%_100%]"
            initial={variants?.exit.initial ?? defaultVariants.exit.initial}
            animate={variants?.exit.animate ?? defaultVariants.exit.animate}
            transition={{
              ...transition,
              duration,
              delay: getExitDelay(index),
            }}
          >
            {letter === " " ? "\u00A0" : letter}
          </motion.span>
          <span className="invisible">
            {letter === " " ? "\u00A0" : letter}
          </span>
        </span>
      ))}
      <span className="sr-only">{children}</span>
    </span>
  );
}
