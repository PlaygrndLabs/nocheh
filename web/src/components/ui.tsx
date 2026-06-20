import type { ReactNode } from "react";

export type NoticeKind = "success" | "error";

export interface NoticeMessage {
  readonly kind: NoticeKind;
  readonly text: string;
}

interface PageHeaderProps {
  readonly title: string;
  readonly subtitle: string;
}

export function PageHeader({ title, subtitle }: PageHeaderProps): JSX.Element {
  return (
    <>
      <h2>{title}</h2>
      <p className="subtitle">{subtitle}</p>
    </>
  );
}

interface CardProps {
  readonly title?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Card({ title, children, className = "" }: CardProps): JSX.Element {
  return (
    <div className={["card", className].filter(Boolean).join(" ")}>
      {title !== undefined && <h3>{title}</h3>}
      {children}
    </div>
  );
}

export function Notice({ message }: { readonly message: NoticeMessage | null }): JSX.Element | null {
  return message === null ? null : <div className={`notice ${message.kind}`}>{message.text}</div>;
}

interface StatusFlagProps {
  readonly active: boolean;
  readonly activeLabel?: string;
  readonly inactiveLabel?: string;
}

export function StatusFlag({ active, activeLabel = "set", inactiveLabel = "not set" }: StatusFlagProps): JSX.Element {
  return <span className={active ? "ok" : "warn"}>{active ? activeLabel : inactiveLabel}</span>;
}

interface NumericFieldProps {
  readonly label: string;
  readonly value: number;
  onChange(value: number): void;
}

export function NumericField({ label, value, onChange }: NumericFieldProps): JSX.Element {
  return (
    <>
      <label>{label}</label>
      <input type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </>
  );
}
