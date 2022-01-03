import { readdirSync, readFileSync } from "fs"
import * as yaml from "js-yaml"
import { basename, join } from "path"
import * as yup from "yup"
import * as cache from "./cache"
import { Features } from "./features"
import { throttledFetch } from "./utils"

//
// Yes, these types and things seem pretty overcomplicated, but it sure makes
// importing data and working with TypeScript a lot easier.
//

const booleanOrUrl = yup.mixed<string | boolean>().when("booleanOrUrl", {
  is: (val: any) => typeof val === "string",
  then: yup.string().url(),
  otherwise: yup.boolean().optional(),
})

const booleanOrString = yup.mixed<string | boolean>().when("booleanOrString", {
  is: (val: any) => typeof val === "string",
  then: yup.string(),
  otherwise: yup.boolean().optional(),
})

const githubRepoSchema = yup
  .string()
  .matches(/^\S+\/\S+$/, "Must be a username/repo pair")

const frameworksSchema = yup.object({
  vanilla: booleanOrUrl,
  react: booleanOrUrl,
  vue: booleanOrUrl,
  angular: booleanOrUrl,
  jquery: booleanOrUrl,
  ember: booleanOrUrl,
})

export type FrameworkName = keyof yup.Asserts<typeof frameworksSchema>

// Validate and type the data we get from the YAML files in `data`.
const yamlSchema = yup.object({
  title: yup.string().required(),
  description: yup.string().required(),
  homeUrl: yup.string().url(),
  demoUrl: yup.string().url(),
  githubRepo: githubRepoSchema,
  npmPackage: yup.string(),
  ignoreBundlephobia: yup.boolean(),
  license: yup.string(),
  revenueModel: yup.string(),
  frameworks: frameworksSchema,
  features: yup.object(
    Object.fromEntries(
      Object.keys(Features).map((key) => [key, booleanOrString])
    )
  ),
})

// Allow additional information to be added to the library info dictionaries.
const libraryInfoSchema = yamlSchema.concat(
  yup.object({
    id: yup.string().required(),
    github: yup.object({
      url: yup.string().url(),
      stars: yup.number(),
      forks: yup.number(),
      openIssues: yup.number(),
      watchers: yup.number(),
      subscribers: yup.number(),
      network: yup.number(),
      contributors: yup.number(),
    }),
    npm: yup.object({
      url: yup.string().url(),
      downloads: yup.number(),
    }),
    bundlephobia: yup.object({
      url: yup.string().url(),
      rawSize: yup.number(),
      gzipSize: yup.number(),
    }),
  })
)

type ImportedYAMLInfo = yup.Asserts<typeof yamlSchema>
export type LibraryInfo = yup.Asserts<typeof libraryInfoSchema>

const allowedFeatures = new Set(Object.keys(Features))

// Get all the library data, fetching from APIs or using the cache as necessary.
export const getLibraries = async (): Promise<LibraryInfo[]> => {
  // Get paths to all YAML files.
  const dataDir = join(process.cwd(), "data")
  const paths = readdirSync(dataDir)
    .filter((name) => /\.yml$/.test(name))
    .map((name) => join(dataDir, name))

  const items: LibraryInfo[] = []
  await Promise.all(
    paths.map(async (path) => {
      const id = basename(path, ".yml")

      // Load raw YAML data and make sure it validates.
      const obj = yaml.load(readFileSync(path, "utf8")) as Object
      try {
        yamlSchema.validateSync(obj) // Asserts the Object type
      } catch (err) {
        throw new Error(`${path} is not valid: ${err}`)
      }
      let item = libraryInfoSchema.validateSync({ id, ...obj })

      // Populate GitHub data if the library has a GitHub repo.
      if (item.githubRepo) {
        const key1 = `gh-${item.githubRepo}-info`
        let data: any = cache.get(key1)
        if (!data) {
          try {
            const res = await throttledFetch(
              `https://api.github.com/repos/${item.githubRepo}`
            )
            data = res.data

            if (data.full_name !== item.githubRepo) {
              throw new Error(
                `GitHub repo ${item.githubRepo} has moved to ${data.full_name}`
              )
            }

            cache.set(key1, data)
          } catch (err) {
            throw new Error(`Error getting GitHub data for ${id}: ${err}`)
          }
        }

        const key2 = `gh-${item.githubRepo}-contributors`
        let stats: any = cache.get(key2)
        if (!stats) {
          try {
            const pageSize = 100
            const url = `https://api.github.com/repos/${item.githubRepo}/contributors?per_page=${pageSize}`
            const res1 = await throttledFetch(url)
            const data: any = res1.data
            if (data.length < pageSize || !res1.headers.get("link")) {
              stats = { contributors: data.length }
            } else {
              const header = res1.headers.get("link")?.split(",") || []
              const part = header.find((s) => /rel="last"/.test(s)) ?? ""
              const match = part.match(/\bpage=(\d+)/)
              const lastPage = Number(match && match[1])
              const res2 = await throttledFetch(`${url}&page=${lastPage}`)
              const data: any = res2.data
              const total = pageSize * (lastPage - 1) + data.length
              stats = { contributors: total }
            }
            cache.set(key2, stats)
          } catch (err) {
            throw new Error(`Error getting GitHub stats for ${id}: ${err}`)
          }
        }

        item.github = {
          url: data.html_url,
          stars: data.stargazers_count,
          forks: data.forks_count,
          openIssues: data.open_issues_count,
          watchers: data.watchers_count,
          subscribers: data.subscribers_count,
          network: data.network_count,
          contributors: stats.contributors,
        }
      }

      // Populate NPM data if the library has an NPM package name.
      if (item.npmPackage) {
        const name = item.npmPackage
        const key = `npm-${name}`
        let npm = cache.get(key)
        if (!npm) {
          try {
            const res = await throttledFetch(
              `https://api.npmjs.org/downloads/point/last-week/${name}`
            )
            const data: any = res
            npm = {
              url: `https://www.npmjs.com/package/${name}`,
              downloads: data.downloads,
            }
            cache.set(key, npm)
          } catch (err) {
            throw new Error(`Error getting NPM data for ${name}: ${err}`)
          }
        }
        item.npm = npm
      }

      // Grab bundle sizes from Bundlephobia.
      if (item.npmPackage && item.ignoreBundlephobia !== true) {
        const name = item.npmPackage
        const key = `bundlephobia-${name}`
        let bundlephobia = cache.get(key)
        if (!bundlephobia) {
          try {
            const res = await throttledFetch(
              `https://bundlephobia.com/api/size?package=${name}`
            )
            const data: any = res
            bundlephobia = {
              url: `https://bundlephobia.com/result?p=${name}`,
              rawSize: data.size,
              gzipSize: data.gzip,
            }
            cache.set(key, bundlephobia)
          } catch (err: any) {
            // For now, some packages like pqgrid seem to break their build system, so
            // ignore 500 errors.
            throw new Error(
              err.response
                ? `Bundlephobia API returned ${err.response.status} for package ${name}`
                : `Bundlephobia failed for package ${name}: ${err}`
            )
          }
        }
        item.bundlephobia = bundlephobia
      }

      items.push(libraryInfoSchema.validateSync(item))
    })
  )

  // Just a quick sanity check here.
  if (items.length !== paths.length) {
    throw new Error(
      `Incomplete data. Parsed ${paths.length} YAML files but only got ${items.length} info objects.`
    )
  }

  return items
}
