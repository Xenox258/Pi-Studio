import { Show } from 'solid-js';
import { providerInitials, providerPresentation } from '../../data/providers';

export default function ProviderLogo(props: { id: string; name: string; size?: 'small' | 'large' }) {
  const presentation = () => providerPresentation(props.id);

  return (
    <span
      class={`provider-brand-logo provider-brand-logo--${props.size ?? 'small'}`}
      style={{ background: presentation().color }}
      aria-hidden="true"
    >
      <Show when={presentation().logo} fallback={<b>{providerInitials(props.name)}</b>}>
        {logo => <img src={logo()} alt="" />}
      </Show>
    </span>
  );
}
