/* @flow */

import { on } from 'post-robot/src';
import { ZalgoPromise } from 'zalgo-promise/src';
import { getDomainFromUrl, matchDomain } from 'cross-domain-utils/src';

import { BaseComponent } from '../base';
import { ChildComponent } from '../child';
import { ParentComponent, type RenderOptionsType } from '../parent';
import { DelegateComponent, type DelegateOptionsType } from '../delegate';
import { getInternalProps, type UserPropsDefinitionType, type BuiltInPropsDefinitionType, type PropsType, type BuiltInPropsType, type PropDefinitionType, type PropDefinitionTypeEnum, type PropTypeEnum } from './props';
import { isXComponentWindow, getComponentMeta } from '../window';
import { CONTEXT_TYPES, POST_MESSAGE, WILDCARD } from '../../constants';
import { validate } from './validate';
import { defaultContainerTemplate, defaultPrerenderTemplate } from './templates';

import * as drivers from '../../drivers';
import { info, error, warn, setLogLevel, memoize } from '../../lib';


/*  Component
    ---------

    This is the spec for the component. The idea is, when I call xcomponent.create(), it will create a new instance
    of Component with the blueprint needed to set up ParentComponents and ChildComponents.

    This is the one portion of code which is required by -- and shared to -- both the parent and child windows, and
    contains all of the configuration needed for them to set themselves up.
*/

export type ComponentOptionsType<P> = {

    tag : string,

    url? : EnvString,
    buildUrl? : (BuiltInPropsType & P) => string | ZalgoPromise<string>,

    domain? : EnvStringRegExp,
    bridgeUrl? : EnvString,
    bridgeDomain? : EnvString,

    props? : UserPropsDefinitionType<P>,

    dimensions? : CssDimensionsType,
    scrolling? : boolean,
    autoResize? : boolean | { width? : boolean, height? : boolean, element? : string },

    defaultLogLevel? : string,
    allowedParentDomains? : StringMatcherType,

    version? : string,
    defaultEnv? : string,


    contexts? : { iframe? : boolean, popup? : boolean },
    defaultContext? : string,

    containerTemplate? : (RenderOptionsType) => HTMLElement,
    prerenderTemplate? : (RenderOptionsType) => HTMLElement,

    validate? : (Component<P>, PropsType) => void // eslint-disable-line no-use-before-define
};

export type ComponentDriverType<P, T : mixed> = {
    global : () => ?T,
    register : (Component<P>, T) => mixed
};

export class Component<P> extends BaseComponent<P> {

    name : string
    looseProps : boolean

    tag : string
    url : EnvString

    domain : EnvStringRegExp
    bridgeUrl : EnvString
    bridgeDomain : EnvString

    props : UserPropsDefinitionType<P>
    builtinProps : BuiltInPropsDefinitionType<P>

    dimensions : CssDimensionsType
    scrolling : boolean
    autoResize : ?(boolean | { width? : boolean, height? : boolean, element? : string })

    defaultLogLevel : string
    allowedParentDomains : StringMatcherType

    version : string
    defaultEnv : string
    buildUrl : (BuiltInPropsType & P) => string | ZalgoPromise<string>

    contexts : { iframe? : boolean, popup? : boolean }
    defaultContext : string

    containerTemplate : (RenderOptionsType) => HTMLElement
    prerenderTemplate : (RenderOptionsType) => HTMLElement

    validate : (Component<P>, (PropsType & P)) => void

    driverCache : { [string] : mixed }

    constructor(options : ComponentOptionsType<P>) {
        super();
        validate(options);

        // The tag name of the component. Used by some drivers (e.g. angular) to turn the component into an html element,
        // e.g. <my-component>

        this.addProp(options, 'tag');

        this.addProp(options, 'defaultLogLevel', 'info');

        this.addProp(options, 'allowedParentDomains', WILDCARD);

        // initially set log level to default log level configured when creating component
        setLogLevel(this.defaultLogLevel);

        if (Component.components[this.tag]) {
            throw new Error(`Can not register multiple components with the same tag`);
        }

        // Name of the component, used for logging. Auto-generated from the tag name by default.

        this.addProp(options, 'name', this.tag.replace(/-/g, '_'));

        // A json based spec describing what kind of props the component accepts. This is used to validate any props before
        // they are passed down to the child.

        this.builtinProps = getInternalProps();
        this.props = options.props || {};

        if (!options.props) {
            this.looseProps = true;
        }

        // The dimensions of the component, e.g. { width: '300px', height: '150px' }

        this.addProp(options, 'dimensions');
        this.addProp(options, 'scrolling');

        this.addProp(options, 'version', 'latest');

        // The default environment we should render to if none is specified in the parent

        this.addProp(options, 'defaultEnv');

        // A mapping of env->url, used to determine which url to load for which env

        this.addProp(options, 'buildUrl');

        this.addProp(options, 'url');
        this.addProp(options, 'domain');

        this.addProp(options, 'bridgeUrl');
        this.addProp(options, 'bridgeDomain');

        this.addProp(options, 'attributes', {});

        // A url to use by default to render the component, if not using envs



        // The allowed contexts. For example { iframe: true, popup: false }

        this.addProp(options, 'contexts', { iframe: true, popup: false });

        // The default context to render to

        this.addProp(options, 'defaultContext');

        // Auto Resize option

        this.addProp(options, 'autoResize', false);

        // Templates and styles for the parent page and the initial rendering of the component

        this.addProp(options, 'containerTemplate', defaultContainerTemplate);
        this.addProp(options, 'prerenderTemplate', defaultPrerenderTemplate);

        this.addProp(options, 'validate');

        // A mapping of tag->component so we can reference components by string tag name

        Component.components[this.tag] = this;

        // Register all of the drivers for instantiating components. The model used is -- there's a standard javascript
        // way of rendering a component, then each other technology (e.g. react) needs to hook into that interface.
        // This makes us a little more pluggable and loosely coupled.
        this.registerDrivers();
        this.registerChild();
        this.listenDelegate();
    }

    @memoize
    getPropNames() : Array<string> {
        let props = Object.keys(this.props);

        for (let key of Object.keys(this.builtinProps)) {
            if (props.indexOf(key) === -1) {
                props.push(key);
            }
        }

        return props;
    }

    getProp<T : PropTypeEnum, S : PropDefinitionTypeEnum>(name : string) : PropDefinitionType<T, P, S> {
        // $FlowFixMe
        return this.props[name] || this.builtinProps[name];
    }

    registerDrivers() {
        this.driverCache = {};

        for (let driverName of Object.keys(drivers)) {
            if (driverName.indexOf('_') === 0) {
                continue;
            }

            let driver = drivers[driverName];
            let glob = driver.global();
            if (glob) {
                this.driver(driverName, glob);
            }
        }
    }

    driver(name : string, dep : mixed) : mixed {
        if (!drivers[name]) {
            throw new Error(`Could not find driver for framework: ${name}`);
        }

        if (!this.driverCache[name]) {
            this.driverCache[name] = drivers[name].register(this, dep);
        }

        return this.driverCache[name];
    }

    registerChild() {
        if (isXComponentWindow()) {
            ZalgoPromise.try(() => {
                let componentMeta = getComponentMeta();

                if (componentMeta.tag === this.tag) {
                    window.xchild = new ChildComponent(this);
                    window.xprops = window.xchild.props;
                }
            });
        }
    }

    listenDelegate() {
        on(`${POST_MESSAGE.DELEGATE}_${this.name}`, ({ source, origin, data }) => {

            let domain = this.getDomain(null, data.env || this.defaultEnv);

            if (!domain) {
                throw new Error(`Could not determine domain to allow remote render`);
            }

            if (!matchDomain(domain, origin)) {
                throw new Error(`Can not render from ${origin} - expected ${ domain.toString() }`);
            }

            let delegate = this.delegate(source, data.options);

            return {
                overrides: delegate.getOverrides(data.context),
                destroy:   () => delegate.destroy()
            };
        });
    }


    getValidDomain(url : ?string) : ?(string | RegExp) {

        if (!url) {
            return;
        }

        let domain = getDomainFromUrl(url);

        if (typeof this.domain === 'string' && domain === this.domain) {
            return domain;
        }

        if (this.domain && typeof this.domain === 'object') {
            for (let env of Object.keys(this.domain)) {

                if (env === 'test') {
                    continue;
                }

                if (domain === this.domain[env]) {
                    return domain;
                }
            }
        }
    }


    getDomain(url : ?string, env : string) : ?(string | RegExp) {

        let domain = this.getForEnv(this.domain, env);

        if (domain) {
            return domain;
        }

        domain = this.getValidDomain(url);

        if (domain) {
            return domain;
        }

        // $FlowFixMe
        let envUrl = this.getForEnv(this.url, env);

        if (envUrl) {
            // $FlowFixMe
            return getDomainFromUrl(envUrl);
        }

        if (url) {
            return getDomainFromUrl(url);
        }
    }

    getBridgeUrl(env : string) : ?string {
        // $FlowFixMe
        return this.getForEnv(this.bridgeUrl, env);
    }

    getForEnv(item : (string | RegExp) | { [string] : (string | RegExp) }, env : ?string) : ?(string | RegExp) {

        if (!item) {
            return;
        }

        if (typeof item === 'string' || item instanceof RegExp) {
            return item;
        }

        if (!env) {
            env = this.defaultEnv;
        }

        if (!env) {
            return;
        }

        if (env && typeof item === 'object' && item[env]) {
            return item[env];
        }
    }

    getBridgeDomain(env : string) : ?string {

        // $FlowFixMe
        let bridgeDomain = this.getForEnv(this.bridgeDomain, env);

        if (bridgeDomain) {
            // $FlowFixMe
            return bridgeDomain;
        }

        let bridgeUrl = this.getBridgeUrl(env);

        if (bridgeUrl) {
            return getDomainFromUrl(bridgeUrl);
        }
    }

    getUrl(env : string, props : BuiltInPropsType & P) : ?(string | ZalgoPromise<string>) {

        // $FlowFixMe
        let url = this.getForEnv(this.url, env);

        if (url) {
            return url;
        }

        if (this.buildUrl) {
            return this.buildUrl(props);
        }
    }

    isXComponent() : boolean {
        return isXComponentWindow();
    }

    isChild() : boolean {
        return isXComponentWindow() && window.xprops && getComponentMeta().tag === this.tag;
    }


    createError(message : string, tag : ?string) : Error {
        return new Error(`[${ tag || this.tag  }] ${message}`);
    }


    /*  Init
        ----

        Shortcut to instantiate a component on a parent page, with props
    */

    init(props : (PropsType & P), context : ?string, element : ElementRefType) : ParentComponent<P> {
        return new ParentComponent(this, this.getRenderContext(context), { props });
    }


    delegate(source : CrossDomainWindowType, options : DelegateOptionsType) : DelegateComponent<P> {
        return new DelegateComponent(this, source, options);
    }

    validateRenderContext(context : ?string, element : ?(ElementRefType)) {
        if (context && !this.contexts[context]) {
            throw new Error(`[${this.tag}] Can not render to ${context}`);
        }

        if (element) {
            const defaultContext = this.getDefaultContext();

            if (context === CONTEXT_TYPES.POPUP || defaultContext === CONTEXT_TYPES.POPUP) {
                throw new Error(`[${this.tag}] Context type ${CONTEXT_TYPES.POPUP} does not support use of an element selector`);
            }
        }
    }

    getDefaultContext() : string {
        if (this.defaultContext) {
            return this.defaultContext;
        } else if (this.contexts[CONTEXT_TYPES.IFRAME]) {
            return CONTEXT_TYPES.IFRAME;
        } else if (this.contexts[CONTEXT_TYPES.POPUP]) {
            return CONTEXT_TYPES.POPUP;
        }
    }

    getRenderContext(context : ?string, element : ?(ElementRefType)) : string {
        const defaultContext = this.getDefaultContext();

        if (context || element) {
            this.validateRenderContext(context, element);
            
            return context ? context : defaultContext;
        } else if (defaultContext) {
            return defaultContext;
        }

        throw new Error(`[${this.tag}] No context options available for render`);
    }


    /*  Render
        ------

        Shortcut to render a parent component
    */

    render(props : (PropsType & P), element : ?ElementRefType) : ZalgoPromise<ParentComponent<P>> {
        return ZalgoPromise.try(() => {
            const context = this.getRenderContext(null, element);

            if (context === CONTEXT_TYPES.IFRAME && !element) {
                element = document.body;
            }

            return new ParentComponent(this, context, { props }).render(element);
        });
    }

    renderIframe(props : (PropsType & P), element : ?ElementRefType = document.body) : ZalgoPromise<ParentComponent<P>> {
        return ZalgoPromise.try(() => {
            if (!element) {
                throw new Error(`Expected element to be passed`);
            }

            return new ParentComponent(this, this.getRenderContext(CONTEXT_TYPES.IFRAME), { props }).render(element);
        });
    }

    renderPopup(props : (PropsType & P)) : ZalgoPromise<ParentComponent<P>> {
        return ZalgoPromise.try(() => {
            return new ParentComponent(this, this.getRenderContext(CONTEXT_TYPES.POPUP), { props }).render();
        });
    }

    renderTo(win : CrossDomainWindowType, props : (PropsType & P), element : ?ElementRefType) : ZalgoPromise<ParentComponent<P>> {
        return ZalgoPromise.try(() => {
            const context = this.getRenderContext(null, element);
            
            if (context === CONTEXT_TYPES.IFRAME && !element) {
                element = document.body;
            }

            return new ParentComponent(this, context, { props }).renderTo(win, element);
        });
    }

    renderIframeTo(win : CrossDomainWindowType, props : (PropsType & P), element : ElementRefType) : ZalgoPromise<ParentComponent<P>> {
        return ZalgoPromise.try(() => {
            return new ParentComponent(this, this.getRenderContext(CONTEXT_TYPES.IFRAME), { props }).renderTo(win, element);
        });
    }

    renderPopupTo(win : CrossDomainWindowType, props : (PropsType & P)) : ZalgoPromise<ParentComponent<P>> {
        return ZalgoPromise.try(() => {
            return new ParentComponent(this, this.getRenderContext(CONTEXT_TYPES.POPUP), { props }).renderTo(win);
        });
    }

    prerender(props : (PropsType & P), element : ElementRefType) : { render : ((PropsType & P), ElementRefType) => ZalgoPromise<ParentComponent<P>>, renderTo : (CrossDomainWindowType, (PropsType & P), ElementRefType) => ZalgoPromise<ParentComponent<P>> } {
        let instance = new ParentComponent(this, this.getRenderContext(null, element), { props });
        instance.prefetch();

        return {
            render(innerProps : (PropsType & P), innerElement : ElementRefType) : ZalgoPromise<ParentComponent<P>> {
                if (innerProps) {
                    instance.updateProps(innerProps);
                }

                return instance.render(innerElement);
            },

            renderTo(win : CrossDomainWindowType, innerProps : (PropsType & P), innerElement : ElementRefType) : ZalgoPromise<ParentComponent<P>> {
                if (innerProps) {
                    instance.updateProps(innerProps);
                }

                return instance.renderTo(win, innerElement);
            },

            get html() : ?ZalgoPromise<string> {
                return instance.html;
            },

            set html(value) {
                instance.html = value;
            }
        };
    }

    /*  Log
        ---

        Log an event using the component name
    */

    log(event : string, payload : { [ string ] : string } = {}) {
        info(this.name, event, payload);
    }


    /*  Log Warning
        -----------

        Log a warning
    */

    logWarning(event : string, payload : { [ string ] : string }) {
        warn(this.name, event, payload);
    }


    /*  Log Error
        ---------

        Log an error
    */

    logError(event : string, payload : { [ string ] : string }) {
        error(this.name, event, payload);
    }

    static components : { [string] : Component<*> } = {}

    static getByTag<T>(tag : string) : Component<T> {
        return Component.components[tag];
    }
}
