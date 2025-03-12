import chalk from "chalk";

const logBlock = (type: "INFO" | "UPLOAD" | "UPDATE" | "DELETE" | "ERROR", message: string) => {
    let title: string;
    let styledTitle: string;
    switch (type) {
        case "INFO":
            title = " INFO ";
            styledTitle = chalk.bgBlue.white.bold(title);
            break;
        case "UPLOAD":
            title = " UPLOAD ";
            styledTitle = chalk.bgGreen.white.bold(title);
            break;
        case "UPDATE":
            title = " UPDATE ";
            styledTitle = chalk.bgYellow.black.bold(title);
            break;
        case "DELETE":
            title = " DELETE ";
            styledTitle = chalk.bgRed.white.bold(title);
            break;
        case "ERROR":
            title = " ERROR ";
            styledTitle = chalk.bgRed.white.bold(title);
            break;
        default:
            title = " LOG ";
            styledTitle = chalk.bgMagenta.white.bold(title);
    }
    console.log(`${styledTitle} ${message}`);
};

export default logBlock;