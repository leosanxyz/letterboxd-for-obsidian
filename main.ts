import { App, Plugin, PluginSettingTab, Setting, requestUrl, FuzzySuggestModal, TAbstractFile, TFile, TextComponent, normalizePath, moment, Notice } from 'obsidian';
import { XMLParser } from 'fast-xml-parser';
import {
	getDailyNoteSettings
} from "obsidian-daily-notes-interface";


interface LetterboxdSettings {
	username: string;
	dateFormat: string;
	path: string;
	sort: string;
	callout: 'List' | 'ListReview' | 'Callout' | 'CalloutPoster';
	stars: number;
	addReferenceId: boolean;
	syncMovieNotes: boolean;
	moviesPath: string;
}

/**
 * Represents one item in the Letterboxd RSS feed
 * 
 * @example
 * ```
 * {
 *  "title": "Ahsoka, 2023 - ★★★★",
 *  "link": "https://letterboxd.com/fleker/film/ahsoka/",
 *  "guid": "letterboxd-review-568742403",
 *  "pubDate": "Thu, 4 Apr 2024 17:28:09 +1300",
 *  "letterboxd:watchedDate": "2024-04-04",
 *  "letterboxd:rewatch": "No",
 *  "letterboxd:filmTitle": "Ahsoka",
 *  "letterboxd:filmYear": 2023,
 *  "letterboxd:memberRating": 4,
 *  "tmdb:tvId": 114461,
 *  "description": "<p><img src=\"https://a.ltrbxd.com/resized/film-poster/1/0/5/5/4/3/0/1055430-ahsoka-0-600-0-900-crop.jpg?v=b8ec715c15\"/></p> <p>...</p> ",
 *  "dc:creator": "fleker"
 * },
 * ```
 */

interface RSSEntry {
	title: string
	link: string
	guid: string
	pubDate: string
	'letterboxd:watchedDate': string
	'letterboxd:rewatch': string
	'letterboxd:filmTitle': string
	'letterboxd:filmYear': number
	'letterboxd:memberRating': number
	'tmdb:tvId': number
	description: string
	'dc:creator': string
}

interface ParsedEntry {
	filmTitle: string;
	link: string;
	guid: string;
	watchedDate: string;
	filmYear?: number;
	memberRating?: number;
	posterUrl: string | null;
	reviewText: string | null;
}

interface MovieEntry {
	filmTitle: string;
	link: string;
	watchedDate: string;
	filmYear?: number;
	memberRating?: number;
	rating100?: number;
	posterUrl: string | null;
	reviewText: string | null;
}

interface FilmMetadata {
	genres: string[];
	directors: string[];
	cast: string[];
	cover?: string;
	plot?: string;
	scoreLB?: number;
	year?: number;
}

// FileSelect is a subclass of FuzzySuggestModal that is used to select a file from the vault
class FileSelect extends FuzzySuggestModal<TAbstractFile | string> {
	files: TFile[];
	plugin: LetterboxdPlugin;
	values: string[];
	textBox: TextComponent;
	constructor(app: App, plugin: LetterboxdPlugin, textbox: TextComponent) {
		super(app);
		this.files = this.app.vault.getMarkdownFiles();
		this.plugin = plugin;
		// The HTML element for the textbox needs to be passed in to the constructor to update
		this.textBox = textbox;
		this.setPlaceholder('Select or create a file');

		// Logging TAB keypresses to add folder paths to the selection incrementally
		this.scope.register([], 'Tab', e => {
			let child = this.resultContainerEl.querySelector('.suggestion-item.is-selected');
			let text = child ? child.textContent ? child.textContent.split('/') : [] : [];
			let currentInput = this.inputEl.value.split('/');
			let toSlice = text[0] === currentInput[0] ? currentInput.length : 1;
			if (currentInput.length && text[currentInput.length - 1] === currentInput[currentInput.length - 1]) toSlice++;
			this.inputEl.value = text.slice(0, toSlice).join('/');
		});

		// Logging ENTER keypresses to submit the value if there are no selected items
		// ENTER and TAB can only be handelled by different listeners, annoyingly
		this.containerEl.addEventListener('keyup', e => {
			if (e.key !== 'Enter') return;
			if (!this.resultContainerEl.querySelector('.suggestion-item.is-selected') || e.getModifierState('Shift')) {
				this.plugin.settings.path = this.inputEl.value
				this.plugin.saveSettings();
				this.textBox.setValue(this.plugin.settings.path);
				this.close();
			}
		})
	}

	// These functions are built into FuzzySuggestModal
	getItems() {
		return this.files.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent) {
		this.plugin.settings.path = item.path;
		this.plugin.saveSettings();
		this.textBox.setValue(this.plugin.settings.path);
	}
}

const DEFAULT_SETTINGS: LetterboxdSettings = {
	username: '',
	dateFormat: getDailyNoteSettings().format ?? '',
	path: 'Letterboxd Diary',
	sort: 'Old',
	callout: 'List',
	stars: 0,
	addReferenceId: false,
	syncMovieNotes: true,
	moviesPath: '06 - Resources/Movies',
}

const decodeHtmlEntities = (text: string) => {
	const txt = document.createElement("textarea");
	txt.innerHTML = text;
	return txt.value;
};

const toHundredScale = (rating?: number): number | undefined => {
	if (rating === undefined) return undefined;
	return Math.round(rating * 20);
};

const sanitizeMovieFilename = (title: string): string => {
	const cleanTitle = title.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
	return cleanTitle.length ? cleanTitle : 'Untitled Movie';
};

const ensureStringArray = (value: unknown): string[] => {
	if (Array.isArray(value)) {
		return value
			.map((entry) => String(entry).trim())
			.filter((entry) => entry.length > 0);
	}
	if (typeof value === 'string') {
		return value
			.split(',')
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
	return [];
};

const hasValue = (value: unknown): boolean => {
	if (value === undefined || value === null) return false;
	if (typeof value === 'string') return value.trim().length > 0;
	if (Array.isArray(value)) return value.length > 0;
	return true;
};

const uniqueStrings = (values: string[]): string[] => Array.from(new Set(values.map((value) => decodeHtmlEntities(value).trim()).filter((value) => value.length > 0)));

const toWikiLinks = (values: string[]): string[] => uniqueStrings(values).map((value) => `[[${value}]]`);

const extractStringValues = (value: unknown): string[] => {
	if (Array.isArray(value)) {
		return uniqueStrings(value.flatMap((entry) => extractStringValues(entry)));
	}
	if (typeof value === 'string') {
		return uniqueStrings([value]);
	}
	if (value && typeof value === 'object') {
		const namedValue = (value as Record<string, unknown>).name;
		if (typeof namedValue === 'string') return uniqueStrings([namedValue]);
	}
	return [];
};

const splitFrontmatter = (content: string): { frontmatter: string; body: string } => {
	const match = content.match(/^---\n[\s\S]*?\n---\n?/);
	if (!match) return { frontmatter: '', body: content };
	return {
		frontmatter: match[0].endsWith('\n') ? match[0] : `${match[0]}\n`,
		body: content.slice(match[0].length),
	};
};

const parseEntry = (item: RSSEntry): ParsedEntry => {
	const description = document.createElement('div');
	description.innerHTML = item.description ?? '';
	const imgElement = description.querySelector('img');
	const posterUrl = imgElement ? imgElement.src : null;
	const reviewParts = Array.from(description.querySelectorAll('p'))
		.map((p) => (p.textContent ?? '').trim())
		.filter((text) => text.length > 0 && !/^Watched on\b/i.test(text));
	const reviewText = reviewParts.length ? reviewParts.join('\n\n') : null;
	const memberRating = typeof item['letterboxd:memberRating'] === 'number' ? item['letterboxd:memberRating'] : undefined;
	const filmYear = typeof item['letterboxd:filmYear'] === 'number' ? item['letterboxd:filmYear'] : undefined;

	return {
		filmTitle: decodeHtmlEntities(item['letterboxd:filmTitle'] ?? item.title).trim(),
		link: item.link,
		guid: item.guid,
		watchedDate: item['letterboxd:watchedDate'],
		filmYear,
		memberRating,
		posterUrl,
		reviewText,
	};
};

const objToFrontmatter = (obj: Record<string, any>): string => {
	let yamlString = '---\n';
	for (const key in obj) {
		if (Array.isArray(obj[key])) {
			yamlString += `${key}:\n`;
			obj[key].forEach((value: string) => yamlString += `  - ${value}\n`);
		} else {
			yamlString += `${key}: ${obj[key]}\n`;
		}
	}
	return yamlString += '---\n';
}

function starParser(rating: number | undefined, star: number): string {
	if (rating === undefined) return '';
	switch (star) {
		case 0:
		default:
			return `(${rating} stars)`;
		case 1:
			return `(${'★'.repeat(Math.floor(rating)) + (rating % 1 ? '½' : '')})`;
		case 2:
			return `(${'⭐'.repeat(Math.floor(rating)) + (rating % 1 ? '½' : '')})`;
	}
}

function printOut(settings: LetterboxdSettings, item: RSSEntry) {
	const parsed = parseEntry(item);
	const img = parsed.posterUrl;
	const reviewText = parsed.reviewText ? parsed.reviewText.split('\n').join('\r > \r > ') : null;
	const filmTitle = parsed.filmTitle;
	const watchedDate = settings.dateFormat
		? moment(item['letterboxd:watchedDate']).format(settings.dateFormat)
		: item['letterboxd:watchedDate'];
	let stars = starParser(item['letterboxd:memberRating'], settings.stars);
	const reference = (() => {
		if (settings.addReferenceId) {
			return ` ^letterboxd${item.guid.split('-')[2]}`
		}
		return ''
	})()
	switch (settings.callout) {
		case 'List':
			return `- ${stars?.length ? `Reviewed [${filmTitle}](${item['link']}) ` + stars : `Watched [${filmTitle}](${item['link']})`} on [[${watchedDate}]]`;
		case 'ListReview':
			return `- ${reviewText ? `Reviewed ` : `Watched `} [${filmTitle}](${item['link']}) ${stars} on [[${watchedDate}]] ${reviewText ? `\r >${reviewText}\n` : ''}`;
		case 'Callout':
			return `> [!letterboxd]+ ${item['letterboxd:memberRating'] !== undefined || reviewText ? 'Review: ' : 'Watched: '} [${filmTitle}](${item['link']}) ${stars} - [[${watchedDate}]] \r> ${reviewText ? reviewText : ''}${reference}\n`;
		case 'CalloutPoster':
			return `> [!letterboxd]+ ${item['letterboxd:memberRating'] !== undefined || reviewText ? 'Review: ' : 'Watched: '} [${filmTitle}](${item['link']}) ${stars} - [[${watchedDate}]] \r> ${reviewText ? img ? `![${filmTitle}|200](${img}) \r> ${reviewText}` : reviewText : ''}${reference}\n`;
	}
}


export default class LetterboxdPlugin extends Plugin {
	settings: LetterboxdSettings;
	private filmMetadataCache = new Map<string, FilmMetadata>();

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'sync',
			name: 'Pull newest entries',
			callback: async () => {
				if (!this.settings.username) {
					throw new Error('Cannot get data for blank username')
				}
				try {
					const response = await requestUrl(`https://letterboxd.com/${this.settings.username}/rss/`);
					const parser = new XMLParser();
					const parsedRss = parser.parse(response.text);
					const rssItems = parsedRss?.rss?.channel?.item;
					const diaryEntries = (Array.isArray(rssItems) ? rssItems : rssItems ? [rssItems] : []) as RSSEntry[];
					const sortedEntries = diaryEntries.sort((a, b) => {
						const dateA = new Date(a.pubDate).getTime();
						const dateB = new Date(b.pubDate).getTime();
						return this.settings.sort === 'Old' ? dateA - dateB : dateB - dateA;
					});
					const newDiaryEntries = await this.syncDiaryNote(sortedEntries);
					const movieNotesProcessed = await this.syncMovieNotes(sortedEntries);
					new Notice(`Letterboxd sync: ${newDiaryEntries} nuevas entradas en diario, ${movieNotesProcessed} peliculas procesadas.`);
				} catch (error) {
					console.error('Letterboxd sync failed', error);
					new Notice(`Letterboxd sync fallo: ${error instanceof Error ? error.message : 'error desconocido'}`);
				}
			},
		})

		this.addSettingTab(new LetterboxdSettingTab(this.app, this));
	}

	private async syncDiaryNote(entries: RSSEntry[]): Promise<number> {
		const filename = normalizePath(this.settings.path.endsWith('.md') ? this.settings.path : `${this.settings.path}.md`);
		const diaryMdArr = entries.map((item) => printOut(this.settings, item));
		const diaryFile = this.app.vault.getFileByPath(filename);

		if (diaryFile === null) {
			const pathArray = this.settings.path.split('/');
			pathArray.pop();
			if (pathArray.length > 1) {
				await this.ensureFolderExists(pathArray.join('/'));
			}
			await this.app.vault.create(filename, diaryMdArr.join('\n'));
			return diaryMdArr.length;
		}

		let frontMatter = '';
		await this.app.fileManager.processFrontMatter(diaryFile, (data) => {
			if (Object.keys(data).length) frontMatter = objToFrontmatter(data);
		});

		let newEntriesCount = 0;
		await this.app.vault.process(diaryFile, (data) => {
			const diaryContentsArr = data.split('\n');
			if (frontMatter.length) {
				let count = 0;
				while (diaryContentsArr.length > 0) {
					const firstElement = diaryContentsArr.shift();
					if (firstElement === '---') {
						count++;
						if (count === 2) break;
					}
				}
			}
			const diaryContentsSet = new Set(diaryContentsArr);
			const newEntries = diaryMdArr.filter((entry: string) => !diaryContentsSet.has(entry));
			newEntriesCount = newEntries.length;
			const finalEntries = this.settings.sort === 'Old'
				? [...diaryContentsArr, ...newEntries]
				: [...newEntries, ...diaryContentsArr];
			return frontMatter.length ? frontMatter + finalEntries.join('\n') : finalEntries.join('\n');
		});
		return newEntriesCount;
	}

	private async syncMovieNotes(entries: RSSEntry[]): Promise<number> {
		if (!this.settings.syncMovieNotes) return 0;
		await this.ensureFolderExists(this.settings.moviesPath);
		const movieMap = this.groupEntriesByMovie(entries);
		for (const movieEntry of movieMap.values()) {
			await this.upsertMovieNote(movieEntry);
		}
		return movieMap.size;
	}

	private getFilmPageUrl(entryLink: string): string | null {
		try {
			const url = new URL(entryLink);
			const pathParts = url.pathname.split('/').filter(Boolean);
			const filmIndex = pathParts.findIndex((part) => part === 'film');
			if (filmIndex < 0 || !pathParts[filmIndex + 1]) return null;
			return `${url.origin}/film/${pathParts[filmIndex + 1]}/`;
		} catch {
			return null;
		}
	}

	private findMovieSchema(data: unknown): Record<string, unknown> | null {
		if (Array.isArray(data)) {
			for (const entry of data) {
				const found = this.findMovieSchema(entry);
				if (found) return found;
			}
			return null;
		}
		if (!data || typeof data !== 'object') return null;
		const record = data as Record<string, unknown>;
		const typeValue = record['@type'];
		const isMovieType = (typeof typeValue === 'string' && typeValue.toLowerCase() === 'movie')
			|| (Array.isArray(typeValue) && typeValue.some((type) => typeof type === 'string' && type.toLowerCase() === 'movie'));
		if (isMovieType) return record;
		for (const value of Object.values(record)) {
			const found = this.findMovieSchema(value);
			if (found) return found;
		}
		return null;
	}

	private parseFilmMetadataFromHtml(html: string): FilmMetadata | null {
		const parser = new DOMParser();
		const htmlDoc = parser.parseFromString(html, 'text/html');
		let ldJsonScripts = Array.from(htmlDoc.querySelectorAll('script[type="application/ld+json"]'));
		if (!ldJsonScripts.length) {
			// Fallback for edge cases where scripts are not exposed in the parsed DOM.
			const ldJsonMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
			ldJsonScripts = ldJsonMatches.map((rawScript) => {
				const scriptEl = document.createElement('script');
				const contentMatch = rawScript.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
				scriptEl.textContent = contentMatch?.[1] ?? '';
				return scriptEl;
			});
		}
		let movieSchema: Record<string, unknown> | null = null;

		for (const script of ldJsonScripts) {
			const rawJson = script.textContent?.trim();
			if (!rawJson) continue;
			try {
				const cleanedJson = rawJson
					.replace(/^\/\*\s*<!\[CDATA\[\s*\*\/\s*/i, '')
					.replace(/\s*\/\*\s*\]\]>\s*\*\/$/i, '')
					.trim();
				const parsedJson = JSON.parse(cleanedJson) as unknown;
				const foundSchema = this.findMovieSchema(parsedJson);
				if (foundSchema) {
					movieSchema = foundSchema;
					break;
				}
			} catch {
				continue;
			}
		}

		if (!movieSchema) return null;

		const releasedEvent = movieSchema.releasedEvent;
		let year: number | undefined;
		if (Array.isArray(releasedEvent) && releasedEvent.length > 0) {
			const startDate = (releasedEvent[0] as Record<string, unknown>)?.startDate;
			if (typeof startDate === 'string') {
				const yearMatch = startDate.match(/\d{4}/);
				if (yearMatch) year = parseInt(yearMatch[0], 10);
			}
		}
		if (!year && typeof movieSchema.dateCreated === 'string') {
			const yearMatch = movieSchema.dateCreated.match(/\d{4}/);
			if (yearMatch) year = parseInt(yearMatch[0], 10);
		}

		const aggregateRating = movieSchema.aggregateRating as Record<string, unknown> | undefined;
		let scoreLB: number | undefined;
		if (aggregateRating) {
			const ratingValue = aggregateRating.ratingValue;
			if (typeof ratingValue === 'number') scoreLB = ratingValue;
			if (typeof ratingValue === 'string') {
				const parsedRating = Number.parseFloat(ratingValue);
				if (!Number.isNaN(parsedRating)) scoreLB = parsedRating;
			}
		}

		let plot = '';
		const metaDescription = htmlDoc.querySelector('meta[name="description"]')?.getAttribute('content')
			|| htmlDoc.querySelector('meta[property="og:description"]')?.getAttribute('content');
		if (metaDescription) plot = decodeHtmlEntities(metaDescription).trim();
		if (!plot && typeof movieSchema.description === 'string') plot = decodeHtmlEntities(movieSchema.description).trim();

		const cover = typeof movieSchema.image === 'string' ? movieSchema.image : undefined;

		return {
			genres: extractStringValues(movieSchema.genre),
			directors: extractStringValues(movieSchema.director),
			cast: extractStringValues(movieSchema.actors).slice(0, 5),
			cover,
			plot: plot.length ? plot : undefined,
			scoreLB,
			year,
		};
	}

	private async fetchFilmMetadata(entryLink: string): Promise<FilmMetadata | null> {
		const filmUrl = this.getFilmPageUrl(entryLink);
		if (!filmUrl) return null;

		const cachedMetadata = this.filmMetadataCache.get(filmUrl);
		if (cachedMetadata !== undefined) return cachedMetadata;

		try {
			const response = await requestUrl(filmUrl);
			const parsedMetadata = this.parseFilmMetadataFromHtml(response.text);
			if (parsedMetadata) this.filmMetadataCache.set(filmUrl, parsedMetadata);
			return parsedMetadata;
		} catch (error) {
			console.warn(`Letterboxd metadata fetch failed for ${filmUrl}`, error);
			return null;
		}
	}

	private groupEntriesByMovie(entries: RSSEntry[]): Map<string, MovieEntry> {
		const movieMap = new Map<string, MovieEntry>();

		for (const item of entries) {
			const parsed = parseEntry(item);
			if (!parsed.filmTitle.length) continue;
			const key = (parsed.link || parsed.filmTitle).replace(/\/+$/, '').toLowerCase();
			const existing = movieMap.get(key);
			const candidate: MovieEntry = {
				filmTitle: parsed.filmTitle,
				link: parsed.link,
				watchedDate: parsed.watchedDate,
				filmYear: parsed.filmYear,
				memberRating: parsed.memberRating,
				rating100: toHundredScale(parsed.memberRating),
				posterUrl: parsed.posterUrl,
				reviewText: parsed.reviewText,
			};

			if (!existing) {
				movieMap.set(key, candidate);
				continue;
			}

			if (candidate.watchedDate > existing.watchedDate) {
				existing.watchedDate = candidate.watchedDate;
				existing.link = candidate.link || existing.link;
				existing.filmYear = candidate.filmYear ?? existing.filmYear;
				existing.memberRating = candidate.memberRating ?? existing.memberRating;
				existing.rating100 = candidate.rating100 ?? existing.rating100;
				existing.posterUrl = candidate.posterUrl ?? existing.posterUrl;
				if (candidate.reviewText) {
					existing.reviewText = candidate.reviewText;
				}
			} else {
				if (!existing.posterUrl && candidate.posterUrl) existing.posterUrl = candidate.posterUrl;
				if (!existing.reviewText && candidate.reviewText) existing.reviewText = candidate.reviewText;
				if (!existing.filmYear && candidate.filmYear) existing.filmYear = candidate.filmYear;
				if (existing.memberRating === undefined && candidate.memberRating !== undefined) {
					existing.memberRating = candidate.memberRating;
					existing.rating100 = candidate.rating100;
				}
			}
		}

		return movieMap;
	}

	private async upsertMovieNote(movieEntry: MovieEntry): Promise<void> {
		const fileName = sanitizeMovieFilename(movieEntry.filmTitle);
		const filePath = normalizePath(`${this.settings.moviesPath}/${fileName}.md`);
		let movieFile = this.app.vault.getFileByPath(filePath);
		const today = moment().format('YYYY-MM-DD');
		const existingFrontmatter = movieFile ? this.app.metadataCache.getFileCache(movieFile)?.frontmatter : undefined;
		const needsMetadata = !movieFile
			|| !existingFrontmatter
			|| !hasValue(existingFrontmatter.genre)
			|| !hasValue(existingFrontmatter.director)
			|| !hasValue(existingFrontmatter.cast)
			|| !hasValue(existingFrontmatter.plot)
			|| !hasValue(existingFrontmatter.scoreLB);
		const filmMetadata = needsMetadata ? await this.fetchFilmMetadata(movieEntry.link) : null;

		if (!movieFile) {
			movieFile = await this.app.vault.create(filePath, '---\n---\n');
		}

		await this.app.fileManager.processFrontMatter(movieFile, (frontmatter) => {
			const categories = ensureStringArray(frontmatter.category);
			if (!categories.includes('[[Movies]]')) categories.push('[[Movies]]');
			frontmatter.category = categories.length ? categories : ['[[Movies]]'];

			if (!hasValue(frontmatter.genre)) frontmatter.genre = toWikiLinks(filmMetadata?.genres ?? []);
			if (!hasValue(frontmatter.director)) frontmatter.director = toWikiLinks(filmMetadata?.directors ?? []);
			if (!hasValue(frontmatter.cast)) frontmatter.cast = toWikiLinks(filmMetadata?.cast ?? []);
			if (!hasValue(frontmatter.plot)) frontmatter.plot = filmMetadata?.plot ?? '';

			if (!hasValue(frontmatter.created)) frontmatter.created = today;
			if (!hasValue(frontmatter.year) && filmMetadata?.year !== undefined) frontmatter.year = filmMetadata.year;
			if (!hasValue(frontmatter.year) && movieEntry.filmYear !== undefined) frontmatter.year = movieEntry.filmYear;
			if (!hasValue(frontmatter.cover) && filmMetadata?.cover) frontmatter.cover = filmMetadata.cover;
			if (!hasValue(frontmatter.cover) && movieEntry.posterUrl) frontmatter.cover = movieEntry.posterUrl;
			if (!hasValue(frontmatter.scoreLB) && filmMetadata?.scoreLB !== undefined) frontmatter.scoreLB = filmMetadata.scoreLB;
			if (!hasValue(frontmatter.scoreLB) && movieEntry.memberRating !== undefined) frontmatter.scoreLB = movieEntry.memberRating;
			const currentRating = Number(frontmatter.rating);
			const shouldSetRating = !hasValue(frontmatter.rating) || Number.isNaN(currentRating) || currentRating === 0;
			if (shouldSetRating && movieEntry.rating100 !== undefined) frontmatter.rating = movieEntry.rating100;
			if (!hasValue(frontmatter.rating) && movieEntry.rating100 === undefined) frontmatter.rating = 0;

			const currentLast = typeof frontmatter.last === 'string' ? frontmatter.last : '';
			if (!currentLast || movieEntry.watchedDate > currentLast) frontmatter.last = movieEntry.watchedDate;

			const tags = ensureStringArray(frontmatter.tags);
			if (!tags.includes('movies')) tags.push('movies');
			if (!tags.includes('review')) tags.push('review');
			frontmatter.tags = tags;
		});

		if (movieEntry.reviewText && movieEntry.reviewText.trim().length > 0) {
			await this.app.vault.process(movieFile, (data) => {
				const { frontmatter, body } = splitFrontmatter(data);
				if (body.trim().length > 0) return data;
				const prefix = frontmatter.length ? `${frontmatter}\n` : '';
				return `${prefix}${movieEntry.reviewText?.trim()}\n`;
			});
		}
	}

	private async ensureFolderExists(folderPath: string): Promise<void> {
		const normalizedFolder = normalizePath(folderPath);
		if (!normalizedFolder.length) return;
		const existing = this.app.vault.getAbstractFileByPath(normalizedFolder);
		if (existing) return;

		const parts = normalizedFolder.split('/');
		let currentPath = '';
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const existingPart = this.app.vault.getAbstractFileByPath(currentPath);
			if (!existingPart) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class LetterboxdSettingTab extends PluginSettingTab {
	plugin: LetterboxdPlugin;
	settings: any

	constructor(app: App, plugin: LetterboxdPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		this.settings = this.plugin.loadData()

		containerEl.empty();

		new Setting(containerEl)
			.setName('Letterboxd username')
			.setDesc('The username to fetch data from. This account must be public.')
			.addText((component) => {
				component.setPlaceholder('username')
				component.setValue(this.plugin.settings.username)
				component.onChange(async (value) => {
					this.plugin.settings.username = value
					await this.plugin.saveSettings()
				})
			})

		let fileSelectorText: TextComponent;
		new Setting(containerEl)
			.setName('Set Note')
			.setDesc('Select the file to save your Letterboxd to. If it does not exist, it will be created.')
			.addText((component) => {
				component.setPlaceholder('')
				component.setValue(this.plugin.settings.path)
				component.onChange(async (value) => {
					this.plugin.settings.path = value
					await this.plugin.saveSettings();
				});
				fileSelectorText = component;
			})
			.addButton((component) => {
				component.setButtonText('Select Note');
				component.onClick(async () => {
					new FileSelect(this.app, this.plugin, fileSelectorText).open();
				})
			});

		new Setting(containerEl)
			.setName('Sync movie notes')
			.setDesc('Create or update one note per movie after each sync.')
			.addToggle((component) => {
				component.setValue(this.plugin.settings.syncMovieNotes);
				component.onChange(async (value) => {
					this.plugin.settings.syncMovieNotes = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Movies folder')
			.setDesc('Folder where movie notes will be created/updated.')
			.addText((component) => {
				component.setPlaceholder('06 - Resources/Movies');
				component.setValue(this.plugin.settings.moviesPath);
				component.onChange(async (value) => {
					this.plugin.settings.moviesPath = value.trim() || '06 - Resources/Movies';
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Sort by Date')
			.setDesc('Select the order to list your diary entries.')
			.addDropdown((component) => {
				component.addOption('Old', 'Oldest First');
				component.addOption('New', 'Newest First');
				component.setValue(this.plugin.settings.sort)
				component.onChange(async (value) => {
					this.plugin.settings.sort = value
					await this.plugin.saveSettings()
				})
			})

		new Setting(containerEl)
			.setName('Display Style')
			.setDesc('Select how to list your reviews. Options cover plain text lists, callouts, or callouts with poster images.')
			.addDropdown((component) => {
				component.addOption('List', 'List Only');
				component.addOption('ListReview', 'List & Reviews');
				component.addOption('Callout', 'Callout');
				component.addOption('CalloutPoster', 'Callout w/ Poster')
				component.setValue(this.plugin.settings.callout.toString());
				component.onChange(async (value: LetterboxdSettings['callout']) => {
					this.plugin.settings.callout = value;
					await this.plugin.saveSettings()
				})
			})
		new Setting(containerEl)
			.setName('Stars')
			.setDesc('Select how you would like stars to be represented.')
			.addDropdown((component) => {
				component.addOption('0', '5 Stars');
				component.addOption('1', '★★★★★');
				component.addOption('2', '⭐⭐⭐⭐⭐')
				component.setValue(this.plugin.settings.stars.toString());
				component.onChange(async (value) => {
					this.plugin.settings.stars = parseInt(value)
					await this.plugin.saveSettings()
				})
			})
		new Setting(containerEl)
			.setName('Add Reference ID')
			.setDesc('Only applies to callouts.')
			.addToggle((component) => {
				component.setValue(this.plugin.settings.addReferenceId)
				component.onChange(async (value) => {
					this.plugin.settings.addReferenceId = value
					await this.plugin.saveSettings()
				})
			})
			new Setting(containerEl)
				.setName('Date Format')
				.setDesc('Enter the Moment.js date format to display watched dates (e.g., YYYY-MM-DD)')
			.addText((text) => {
				text.setPlaceholder('YYYY-MM-DD');
				text.setValue(this.plugin.settings.dateFormat);
		
				// Create a preview element right after the text input.
				const previewEl = containerEl.createEl('div', { cls: 'date-format-preview', text: `This is how it will look: ${moment().format(this.plugin.settings.dateFormat)}` });
		
				// When the text input changes, update the preview.
				text.onChange(async (value) => {
					this.plugin.settings.dateFormat = value;
					await this.plugin.saveSettings();
					try {
						// Update preview with current date in the given format.
						previewEl.textContent = `This is how it will look: ${moment().format(value)}`;
					} catch (error) {
						previewEl.textContent = `This is how it will look: Invalid format`;
					}
					});
				});
			
			
		}
	}
