/** daisyUI <progress> with an indeterminate mode — the attribute has no React prop, so it is set via ref. */
export default function Progress({ value, className = "progress progress-primary" }: { value?: number | null; className?: string }) {
  if (value == null) {
    return <progress key="indet" className={className} ref={(el) => el?.setAttribute("indeterminate", "")} />;
  }
  return <progress key="det" className={className} value={value} max={100} />;
}
