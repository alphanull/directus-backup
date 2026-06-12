/**
 * Ambient module declaration so TypeScript can import `*.vue` single-file components.
 * @author  Frank Kudermann – alphanull
 * @license AGPL-3.0-only
 */

declare module '*.vue' {
    import { DefineComponent } from 'vue';
    const component: DefineComponent<{}, {}, any>;
    export default component;
}
