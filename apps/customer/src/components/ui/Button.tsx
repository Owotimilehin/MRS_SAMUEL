import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "ghost" | "subtle";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  leadingIcon?: ReactNode;
}

/** Primary brand button. The `primary` variant uses the sunrise gradient
 * (locked in feedback memory: `btn--primary` ALWAYS uses `var(--grad)`). */
export function Button({
  variant = "primary",
  leadingIcon,
  children,
  className,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={`btn btn--${variant} ${className ?? ""}`.trim()}
      {...rest}
    >
      {leadingIcon && <span className="ico">{leadingIcon}</span>}
      {children}
    </button>
  );
}
